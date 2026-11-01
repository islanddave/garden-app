// src/lib/voiceShape.js: BUG-VOICEDUPE-003 telemetry.
//
// WHY THIS EXISTS. The index bookkeeping in transcribe.js (finals slotted by index) and voiceResults.js
// (monotonic high-water mark) is correct within one recognizer session, so a duplicate that survives both
// is not a re-read of one index. The candidate neither can see is Chrome delivering the same word at TWO
// DIFFERENT indices (two legitimately distinct finals, landing as "Chinese Chinese"). Content-level dedup
// would be wrong: saying a word twice on purpose is real speech.
//
// Telling those apart needs the RESULT SEQUENCE from a real device. voiceDebug.js records it to
// localStorage behind a flag (`VOICE_DEBUG_FLAG_KEY`) that has to be set, reproduced under and exported by
// hand, and a capture that takes four manual steps from the reporter never happens. This module builds a
// SHAPE summary that can ship automatically as telemetry instead.
//
// NO TRANSCRIPT TEXT EVER LEAVES THE DEVICE. Lengths, finality flags, and equality RELATIONS between
// results, never the words: ux_events is a server-side telemetry table and dictated garden notes are not
// telemetry. Equality is what diagnoses this bug ("were two finals identical, and at which indices") and
// can be reported without the strings.
//
// Normalized for comparison only, never stored, never sent. Trim + case-fold + collapse internal
// whitespace: the duplicate being hunted may differ only in the capitalization or padding Chrome revises
// between deliveries, and a raw === would then report "not a duplicate" wrongly.
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
        // THE DISCRIMINATOR. dup_at/dup_of both non-null means the same text arrived at two DIFFERENT
        // indices, the mechanism no index-keyed fix can catch.
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
