// BUG-VOICEDUPE-005 — the FOURTH recurrence of the doubled dictated word, and the first one whose
// cause is in the FIX rather than in the gap the fix closed.
//
// WHERE DAVE SEES IT (his answer, 2026-08-30): the choose-a-planting search box. That surface reads
// `finalTranscript` out of `onEnd` (lib/comboboxInput.js:107) and REPLACES its query with it
// (PlantingSelect.jsx:472) — it never appends. So a doubled word there cannot come from a consumer
// appending twice; it has to already be inside the string transcribe.js hands over. That narrows the
// cause to the join at transcribe.js:242 having TWO slots holding the same word, which is exactly the
// case BUG-VOICEDUPE-004's cross-slot guard was added to prevent.
//
// WHY THE GUARD MISSES. The guard compares RAW transcripts byte-for-byte:
//
//     lastFinal.text === transcript
//
// while the string the user actually receives is built from TRIMMED slots:
//
//     finalsByIndex.filter(Boolean).map((s) => s.trim()).filter(Boolean).join(' ')
//
// Chrome does not re-emit an echo byte-identically. A continuation segment carries a LEADING SPACE,
// and Chrome capitalises the first final of a segment while leaving a continuation lower-case, and it
// appends sentence punctuation to a settled final. Every one of those makes `===` false and the
// trimmed join true — the guard declines to drop a value the join then duplicates.
//
// WHY THIS WAS NOT CAUGHT BY THE DEVICE RUN THAT MOTIVATED THE FIX. The probe's own log line trims
// before it prints (`ContinuousVoiceProbe.jsx:311`, `text.trim()`), so a leading space is invisible in
// the captured log. The -004 fixture was transcribed FROM that log, which means it encodes
// byte-identical strings because the instrument could not show anything else — not because the device
// emitted them. The instrument decided the fixture, and the fixture decided the guard. The probe's log
// is changed in the same commit to print the raw string, so the next capture can say which of these
// variants the device actually produces.
//
// SCOPE OF THE FIX. Only the COMPARISON is normalised. What gets stored in the slot and what gets
// emitted to `onResult` are untouched raw values, so no caller sees a rewritten transcript. The 600 ms
// bound is unchanged and still does all the work of separating an engine echo from a human repeat —
// normalising without that bound would delete real words, which is the trap -003 correctly refused.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { installFakeSpeechRecognition } from './helpers/fakeSpeechRecognition.js'
import { startLiveTranscription, DUPLICATE_ECHO_WINDOW_MS } from '../lib/transcribe.js'

let mic

beforeEach(() => { mic = installFakeSpeechRecognition(vi) })
afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers() })

// Drives the PICKER's contract specifically: what matters on that surface is the single
// `finalTranscript` delivered to onEnd, not the per-result emissions.
function pickerRun(deliver) {
  let finalTranscript = null
  const emitted = []
  startLiveTranscription({
    onResult: (r) => { if (r.isFinal) emitted.push(r.transcript) },
    onEnd: (e) => { finalTranscript = e.finalTranscript },
  })
  const rec = mic.latest()
  deliver(rec)
  rec.stop()
  return { finalTranscript, emitted }
}

describe('BUG-VOICEDUPE-005 — the echo guard must survive the shapes Chrome actually re-emits', () => {
  it('drops an echo that arrives with a LEADING SPACE (the continuation-segment shape)', () => {
    const { finalTranscript } = pickerRun((rec) => {
      rec.deliverFinal('Chinese', 0)
      rec.deliverFinal(' Chinese', 1)
    })
    expect(finalTranscript).toBe('Chinese')
  })

  it('drops an echo that differs only in CASE', () => {
    const { finalTranscript } = pickerRun((rec) => {
      rec.deliverFinal('Chinese', 0)
      rec.deliverFinal('chinese', 1)
    })
    expect(finalTranscript).toBe('Chinese')
  })

  it('drops an echo that differs only by TRAILING PUNCTUATION', () => {
    const { finalTranscript } = pickerRun((rec) => {
      rec.deliverFinal('bitter melon', 0)
      rec.deliverFinal('bitter melon.', 1)
    })
    expect(finalTranscript).toBe('bitter melon')
  })

  it('drops an echo that differs by INTERNAL whitespace run', () => {
    const { finalTranscript } = pickerRun((rec) => {
      rec.deliverFinal('bitter melon', 0)
      rec.deliverFinal('bitter  melon', 1)
    })
    expect(finalTranscript).toBe('bitter melon')
  })

  it('KEEPS the raw first value — normalisation is for comparison only, never for storage', () => {
    // The stored/emitted value must still be exactly what the engine said, punctuation and all.
    const { finalTranscript, emitted } = pickerRun((rec) => {
      rec.deliverFinal('Suyo Long.', 0)
      rec.deliverFinal(' suyo long', 1)
    })
    expect(emitted).toEqual(['Suyo Long.'])
    expect(finalTranscript).toBe('Suyo Long.')
  })

  // ── The non-vacuity floor. A guard that normalised everything into equality would pass every test
  // above by deleting half of what Dave says. These are the cases that must still get through.
  it('KEEPS two different words at adjacent slots', () => {
    const { finalTranscript } = pickerRun((rec) => {
      rec.deliverFinal('bitter', 0)
      rec.deliverFinal(' melon', 1)
    })
    expect(finalTranscript).toBe('bitter melon')
  })

  it('KEEPS a genuine repeat spoken OUTSIDE the echo window', () => {
    // The time bound is what separates an engine echo from a human saying a word twice, and it is
    // still the only thing doing that job. Advance real wall-clock past the window via a Date stub
    // rather than fake timers, because the guard reads Date.now() directly.
    const base = Date.now()
    const spy = vi.spyOn(Date, 'now')
    spy.mockReturnValue(base)
    let finalTranscript = null
    startLiveTranscription({ onEnd: (e) => { finalTranscript = e.finalTranscript } })
    const rec = mic.latest()
    rec.deliverFinal('Chinese', 0)
    spy.mockReturnValue(base + DUPLICATE_ECHO_WINDOW_MS + 1)
    rec.deliverFinal(' chinese', 1)
    rec.stop()
    spy.mockRestore()
    expect(finalTranscript).toBe('Chinese chinese')
  })

  it('KEEPS a repeat with real speech in between, even when the halves differ in case', () => {
    const { finalTranscript } = pickerRun((rec) => {
      rec.deliverFinal('310 G', 0)
      rec.deliverFinal('blueberries', 1)
      rec.deliverFinal(' 310 g', 2)
    })
    expect(finalTranscript).toBe('310 G blueberries 310 g')
  })
})
