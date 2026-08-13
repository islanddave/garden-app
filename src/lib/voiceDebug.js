// src/lib/voiceDebug.js — BUG-VOICEDUPE-002 raw-event recorder.
//
// WHY THIS EXISTS. BUG-VOICEDUPE-001 shipped a fix that was code-level-verified only, never
// microphone-tested, and it failed Dave's device test on 2026-08-13. There is no microphone in CI
// and no way to synthesize Chrome-on-Android's real event cadence, so the ONLY way to stop guessing
// is to record what the browser actually dispatches on Dave's device and read it back.
//
// This module captures the RAW SpeechRecognitionEvent sequence — per event: resultIndex,
// results.length, and every result's index / isFinal / transcript — plus the start/end/error marks
// around it. Read it at /admin/voice-debug.
//
// INERT WHEN OFF is a hard requirement, not a nicety. Every entry point returns on the flag check
// BEFORE touching the event object, so a disabled recorder never reads `event.results` (the live
// SpeechRecognitionResultList), never allocates a snapshot, and never touches the log. Pinned by
// src/__tests__/voiceDebug.test.js with an event whose `results` getter throws.
//
// Storage is per-browser localStorage (Dave's phone), capped, and holds only his own speech — it is
// never uploaded and no other user's data can appear in it.

export const VOICE_DEBUG_FLAG_KEY = 'garden.voicedebug.v1'
export const VOICE_DEBUG_LOG_KEY  = 'garden.voicedebug.log.v1'

// One dictation is tens of events. The cap bounds a forgotten-on toggle without truncating a real
// capture; the oldest entries are dropped first so the tail (where the duplication lands) survives.
export const VOICE_DEBUG_MAX_ENTRIES = 600

export function isVoiceDebugEnabled() {
  try {
    return typeof localStorage !== 'undefined' && localStorage.getItem(VOICE_DEBUG_FLAG_KEY) === '1'
  } catch {
    return false   // private mode / storage disabled — treat as off, never throw into a mic handler
  }
}

export function setVoiceDebugEnabled(on) {
  try {
    if (typeof localStorage === 'undefined') return false
    if (on) localStorage.setItem(VOICE_DEBUG_FLAG_KEY, '1')
    else    localStorage.removeItem(VOICE_DEBUG_FLAG_KEY)
    return true
  } catch { return false }
}

export function readVoiceDebugLog() {
  try {
    const raw = (typeof localStorage !== 'undefined') ? localStorage.getItem(VOICE_DEBUG_LOG_KEY) : null
    if (!raw) return []
    const parsed = JSON.parse(raw)
    return Array.isArray(parsed) ? parsed : []
  } catch { return [] }
}

export function clearVoiceDebugLog() {
  try { if (typeof localStorage !== 'undefined') localStorage.removeItem(VOICE_DEBUG_LOG_KEY) } catch {}
}

function append(entry) {
  try {
    const log = readVoiceDebugLog()
    log.push(entry)
    const trimmed = log.length > VOICE_DEBUG_MAX_ENTRIES ? log.slice(log.length - VOICE_DEBUG_MAX_ENTRIES) : log
    localStorage.setItem(VOICE_DEBUG_LOG_KEY, JSON.stringify(trimmed))
    return true
  } catch {
    return false   // quota / private mode — a debug recorder must never break dictation
  }
}

// Walks the live SpeechRecognitionResultList by index. Deliberately does NOT spread or Array.from
// it: on some engines the list is an exotic host object and index access is the only reliable read.
function snapshotResults(results) {
  const out = []
  const n = (results && typeof results.length === 'number') ? results.length : 0
  for (let i = 0; i < n; i++) {
    const r = results[i]
    const alt = r && r[0]
    out.push({
      i,
      final: !!(r && r.isFinal),
      text: (alt && typeof alt.transcript === 'string') ? alt.transcript : '',
    })
  }
  return out
}

/**
 * Record one raw onresult event. `source` names the code path so a log can be read back to the
 * surface that produced it ('transcribe', 'EventNew:notes', ...).
 * Returns true if an entry was written. No-op (and no event access at all) when the flag is off.
 */
export function recordVoiceEvent(source, event) {
  if (!isVoiceDebugEnabled()) return false
  let entry
  try {
    entry = {
      t: Date.now(),
      src: String(source || '?'),
      kind: 'result',
      resultIndex: (event && typeof event.resultIndex === 'number') ? event.resultIndex : null,
      len: (event && event.results && typeof event.results.length === 'number') ? event.results.length : 0,
      results: snapshotResults(event && event.results),
    }
  } catch {
    entry = { t: Date.now(), src: String(source || '?'), kind: 'result-unreadable' }
  }
  return append(entry)
}

/**
 * Record a lifecycle mark around the result stream — 'start' | 'end' | 'error' | anything else the
 * caller wants to correlate against. `detail` is stringified defensively.
 */
export function recordVoiceMark(source, kind, detail) {
  if (!isVoiceDebugEnabled()) return false
  let d = null
  try { d = (detail === undefined || detail === null) ? null : String(detail) } catch { d = null }
  return append({ t: Date.now(), src: String(source || '?'), kind: String(kind || 'mark'), detail: d })
}

/**
 * Render the log as the plain text Dave copies out of /admin/voice-debug and pastes back.
 * One line per event; times are ms offsets from the first entry so a cadence is readable at a
 * glance (the duplication is cadence-dependent, so the gaps are evidence).
 */
export function formatVoiceDebugLog(log) {
  const entries = Array.isArray(log) ? log : readVoiceDebugLog()
  if (entries.length === 0) return '(no events captured)'
  const t0 = entries[0].t || 0
  const lines = [
    `# BUG-VOICEDUPE-002 raw Web Speech capture — ${entries.length} entr${entries.length === 1 ? 'y' : 'ies'}`,
    `# started ${new Date(t0).toISOString()}`,
    '# +ms  source  kind  resultIndex/len  then one line per result: [index] FINAL|interim "text"',
    '',
  ]
  for (const e of entries) {
    const dt = String((e.t || 0) - t0).padStart(6, ' ')
    if (e.kind === 'result') {
      lines.push(`+${dt}  ${e.src}  result  resultIndex=${e.resultIndex} len=${e.len}`)
      for (const r of (e.results || [])) {
        lines.push(`         [${r.i}] ${r.final ? 'FINAL  ' : 'interim'} ${JSON.stringify(r.text)}`)
      }
    } else {
      lines.push(`+${dt}  ${e.src}  ${e.kind}${e.detail ? ' ' + e.detail : ''}`)
    }
  }
  return lines.join('\n')
}
