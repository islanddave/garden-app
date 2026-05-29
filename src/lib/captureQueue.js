/**
 * src/lib/captureQueue.js
 *
 * Bite 4 of Post-V2 UX overhaul Increment 2: Field capture durable queue.
 *
 * Wraps IndexedDB for the field-capture queue. Each record:
 *   {
 *     id:          uuid string,
 *     mode:        'field' | 'desk',
 *     kind:        'audio' | 'text',
 *     blob:        Blob | null,         // present iff kind === 'audio'
 *     mime:        string | null,        // 'audio/webm' | 'audio/mp4' | null for text
 *     durationMs:  number | null,        // 0 or null for text
 *     text:        string | null,        // present iff kind === 'text' OR a transcript
 *     capturedAt:  ISO 8601 string,
 *     status:      'queued' | 'recorded' | 'transcribed' | 'handed_off',
 *     attemptCount: number,
 *   }
 *
 * Retention policy (Dave-call this session): Bite 4 does NOT delete blobs.
 * Reason: "brain dump and lose it" is an adoption killer for Jen. Blobs persist
 * indefinitely until a future bite (post-Bite 6) introduces user-initiated
 * cleanup with audit guarantees. Bite 4 ships only the additive APIs:
 * enqueue / list / get / update. No delete / clear / prune in this bite.
 *
 * iOS quota landmine: navigator.storage.persist() is requested from
 * durableStorage.js on FieldCapture first-mount. Without persist(), iOS Safari
 * may evict the IndexedDB store. captureQueue itself does not retry or recover
 * from eviction — it surfaces quota errors via an `error: 'quota'` field on
 * the returned record so the caller can render a user-visible warning.
 *
 * All exported functions are async. Internally we open a single connection
 * per call and let the browser cache it; no module-level handle so that
 * tests can swap in fake-indexeddb cleanly.
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

function generateId() {
  // Fallback to Math.random + timestamp if crypto.randomUUID unavailable
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

/**
 * Open the IndexedDB connection. Returns a Promise<IDBDatabase> or rejects
 * with a string error code: 'unavailable' (no IDB), 'blocked' (open blocked),
 * 'failed' (open errored).
 */
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
 * `blob` should be a Blob; `mime` like 'audio/webm' or 'audio/mp4'; durationMs
 * a number (0 acceptable if duration unknown). `mode` defaults to 'field'.
 */
export async function enqueueRecording({ blob, mime, durationMs, mode = 'field' } = {}) {
  if (!blob) throw new Error('enqueueRecording: blob required')
  const db = await openDb()
  try {
    const record = {
      id:           generateId(),
      mode,
      kind:         KIND.AUDIO,
      blob,
      mime:         mime || null,
      durationMs:   typeof durationMs === 'number' ? durationMs : null,
      text:         null,
      capturedAt:   nowIso(),
      status:       STATUS.RECORDED,
      attemptCount: 0,
    }
    await runTx(db, 'readwrite', (store) => reqToPromise(store.add(record)))
    return record
  } finally {
    db.close()
  }
}

/**
 * Enqueue a text-only entry (tap-fallback or imported note). Returns the
 * stored record (with id). `text` required.
 */
export async function enqueueText({ text, mode = 'field' } = {}) {
  if (!text || typeof text !== 'string') throw new Error('enqueueText: text required')
  const db = await openDb()
  try {
    const record = {
      id:           generateId(),
      mode,
      kind:         KIND.TEXT,
      blob:         null,
      mime:         null,
      durationMs:   null,
      text,
      capturedAt:   nowIso(),
      status:       STATUS.QUEUED,
      attemptCount: 0,
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
 * Update a record. `patch` is merged onto the existing record; non-mergeable
 * fields (id) are protected. Returns the updated record, or null if id absent.
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
 * Mark a record as transcribed; convenience over update().
 */
export async function markTranscribed(id, text) {
  return update(id, { status: STATUS.TRANSCRIBED, text })
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
  const oldest = unprocessed[0]   // list() returns ascending by capturedAt
  return Date.now() - new Date(oldest.capturedAt).getTime()
}
