/**
 * src/lib/audioCapture.js
 *
 * Bite 4 of Post-V2 UX overhaul Increment 2: audio capture wrapper.
 *
 * Wraps `navigator.mediaDevices.getUserMedia` + `MediaRecorder` with the
 * minimum surface FieldCapture needs:
 *
 *   const handle = await startRecording()       // throws or returns handle
 *   const result = await handle.stop()           // → { blob, mime, durationMs }
 *   handle.cancel()                               // → no blob, releases mic
 *
 * iOS landmine #1: sync getUserMedia in the user-activation call frame.
 * Callers MUST call startRecording() synchronously from a pointerdown / touchend /
 * click handler. Awaiting before-the-call breaks iOS user-activation and the
 * permission prompt is denied silently. The button wires this via onPointerDown.
 *
 * iOS landmine #2: MIME selection is browser-divergent. Chrome / Edge accept
 * 'audio/webm', Safari requires 'audio/mp4'. We probe with
 * `MediaRecorder.isTypeSupported` and pick the first supported MIME from the
 * preference order [webm, mp4, ''] (empty string = browser default).
 *
 * Error codes (thrown as string from startRecording):
 *   'unavailable' — no navigator.mediaDevices or no MediaRecorder
 *   'denied'      — permission denied
 *   'no-device'   — no microphone present
 *   'failed'      — anything else
 */

const MIME_PREFERENCE = ['audio/webm', 'audio/mp4', '']

function pickMime() {
  if (typeof MediaRecorder === 'undefined') return null
  for (const m of MIME_PREFERENCE) {
    try {
      if (m === '' || MediaRecorder.isTypeSupported(m)) return m
    } catch { /* keep trying */ }
  }
  return null
}

/**
 * Check whether audio capture is supported in this environment. Synchronous
 * probe; no permission request.
 */
export function isAudioCaptureSupported() {
  try {
    if (typeof navigator === 'undefined') return false
    if (!navigator.mediaDevices || typeof navigator.mediaDevices.getUserMedia !== 'function') return false
    if (typeof MediaRecorder === 'undefined') return false
    return pickMime() !== null
  } catch {
    return false
  }
}

/**
 * Begin recording from the microphone. MUST be called synchronously from a
 * user-activation handler (tap/click/pointerdown) to satisfy iOS sync rules.
 *
 * Returns a handle: `{ stop, cancel, mime }`.
 *  - `stop()`   resolves to `{ blob, mime, durationMs }`.
 *  - `cancel()` releases the mic without producing a blob.
 *  - `mime`     is the MIME the recorder chose.
 *
 * Throws (rejects) a string error code (see top-of-file).
 */
export async function startRecording() {
  if (!isAudioCaptureSupported()) throw 'unavailable'
  const mime = pickMime()
  let stream
  try {
    stream = await navigator.mediaDevices.getUserMedia({ audio: true })
  } catch (e) {
    if (e && (e.name === 'NotAllowedError' || e.name === 'SecurityError')) throw 'denied'
    if (e && (e.name === 'NotFoundError' || e.name === 'OverconstrainedError')) throw 'no-device'
    throw 'failed'
  }
  let recorder
  try {
    recorder = mime ? new MediaRecorder(stream, { mimeType: mime }) : new MediaRecorder(stream)
  } catch {
    // Release the stream we just acquired
    try { stream.getTracks().forEach((t) => t.stop()) } catch {}
    throw 'failed'
  }
  const chunks = []
  const startedAt = Date.now()
  let stopped = false

  recorder.ondataavailable = (e) => {
    if (e && e.data && e.data.size > 0) chunks.push(e.data)
  }

  function releaseStream() {
    try { stream.getTracks().forEach((t) => t.stop()) } catch {}
  }

  function stop() {
    if (stopped) return Promise.reject('failed')
    stopped = true
    return new Promise((resolve, reject) => {
      recorder.onstop = () => {
        try {
          const blob = new Blob(chunks, { type: recorder.mimeType || mime || '' })
          const durationMs = Date.now() - startedAt
          releaseStream()
          resolve({ blob, mime: recorder.mimeType || mime || '', durationMs })
        } catch {
          releaseStream()
          reject('failed')
        }
      }
      recorder.onerror = () => {
        releaseStream()
        reject('failed')
      }
      try { recorder.stop() } catch { releaseStream(); reject('failed') }
    })
  }

  function cancel() {
    if (stopped) return
    stopped = true
    try { recorder.stop() } catch {}
    releaseStream()
  }

  // Start recording. MediaRecorder API has a void start(); errors come via onerror.
  try {
    recorder.start()
  } catch {
    releaseStream()
    throw 'failed'
  }

  return { stop, cancel, mime: recorder.mimeType || mime || '' }
}
