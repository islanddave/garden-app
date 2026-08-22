// src/lib/voiceShape.js — BUG-VOICEDUPE-003.
//
// WHY A THIRD FIX WAS NOT WRITTEN. Two shipped and the defect survived, and reading them explains
// why: both are INDEX bookkeeping. transcribe.js keys consumed finals on `index + ':' + text`;
// voiceResults.js keeps a monotonic high-water mark and cannot re-emit an index at all. Within one
// recognizer session those are correct and duplication through them is structurally impossible.
//
// So the surviving mechanism is not a re-read of one index. The candidate neither fix can see is
// Chrome delivering the same word at TWO DIFFERENT indices — two legitimately distinct finals, which
// a monotonic reader is right to emit and which land in the field as "Chinese Chinese". No amount of
// index bookkeeping detects that, and content-level dedup would be wrong (saying a word twice on
// purpose is real speech, and the -001 comment already refuses to delete words the user said).
//
// Distinguishing those requires the RESULT SEQUENCE from Dave's own device, which is what the
// BUG-VOICEDUPE-002 acceptance test asked for and never got: voiceDebug.js writes to localStorage
// on his phone, behind a flag (`VOICE_DEBUG_FLAG_KEY`) he has to know to set, reproduce under, and
// export by hand. Three reports later that capture does not exist. A capture that requires four
// manual steps from the person reporting the bug is a capture that never happens.
//
// This module builds a SHAPE summary that can ship automatically as telemetry instead.
//
// NO TRANSCRIPT TEXT EVER LEAVES THE DEVICE. Lengths, finality flags, and equality RELATIONS
// between results — never the words. That is a deliberate line: ux_events is a server-side
// telemetry table, and Dave's dictated garden notes are not telemetry. Equality is what diagnoses
// this bug ("were two finals identical, and at which indices"), and equality can be reported
// without the strings.

// Normalized for comparison only — never stored, never sent. Trim + case-fold + collapse internal
// whitespace, because the duplicate we are hunting may differ only in the capitalization or padding
// Chrome revises between deliveries, and a raw === would then report "not a duplicate" wrongly.
function normalize(text) {
  return String(text || '').trim().toLowerCase().replace(/\s+/g, ' ')
}

/**
 * Accumulates the shape of one recognition session.
 *
 * Usage: one instance per recognizer. Call observe(event) from onresult and summary() at onend.
 */
export function createVoiceShapeRecorder() {
  const events = []          // one entry per onresult dispatch
  const finalsSeen = []      // normalized finals, in arrival order, for the equality relation
  let firstDupAtIndex = null // the index whose text had already arrived at an earlier index
  let firstDupOfIndex = null

  return {
    observe(event) {
      let resultIndex = null
      let len = 0
      const results = []
      try {
        resultIndex = typeof event?.resultIndex === 'number' ? event.resultIndex : null
        const list = event?.results
        len = typeof list?.length === 'number' ? list.length : 0
        for (let i = 0; i < len; i++) {
          const r = list[i]
          const isFinal = !!r?.isFinal
          const raw = r?.[0]?.transcript
          const norm = normalize(raw)
          results.push({ i, final: isFinal, len: norm.length })
          // Only finals participate: an interim that later finalizes is not a duplicate of itself.
          if (isFinal && norm) {
            const prior = finalsSeen.indexOf(norm)
            if (prior !== -1 && prior !== i && firstDupAtIndex === null) {
              firstDupAtIndex = i
              firstDupOfIndex = prior
            }
            // Sparse assignment keeps arrival order aligned to index, so a revisited index
            // overwrites rather than appending a phantom.
            finalsSeen[i] = norm
          }
        }
      } catch { /* a shape recorder must never break the recognizer */ }
      events.push({ resultIndex, len, results })
    },

    /**
     * @param emitted how many strings the reader actually handed to the field this session — the
     *   number that matters, because it is what the user sees appended.
     */
    summary(emitted) {
      const finals = finalsSeen.filter(Boolean).length
      return {
        // THE DISCRIMINATOR. dup_at/dup_of both non-null means the same text arrived at two
        // DIFFERENT indices — the mechanism no index-keyed fix can catch, and the one this whole
        // capture exists to confirm or rule out.
        dup_at_index: firstDupAtIndex,
        dup_of_index: firstDupOfIndex,
        distinct_dupe: firstDupAtIndex !== null,
        events: events.length,
        finals,
        emitted: typeof emitted === 'number' ? emitted : null,
        // A single spoken word that produced more than one emission is the user-visible defect,
        // independent of which mechanism caused it.
        over_emitted: typeof emitted === 'number' ? emitted > 1 : null,
        seq: events.slice(0, 12), // capped: ux_events.meta is jsonb but this is a diagnostic, not a log
      }
    },
  }
}
