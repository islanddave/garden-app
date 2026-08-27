// BUG-VOICEDUPE-003 — does the shipped slot guard cover the duplicate the DEVICE actually emits?
//
// The 2026-08-27 probe run on Dave's phone is the first capture that recorded `resultIndex` and
// `results.length` per event (gate B1, added with S0 — the earlier fixture did not have them). It
// shows the duplicate arriving at a NEW SLOT, not as a re-delivery of the old one:
//
//     9916ms  result resultIndex=4 len=5   [4] FINAL "310 G"
//    10188ms  result resultIndex=5 len=6   [5] FINAL "310 G"
//
// 272 ms apart, and the run before it measured the same pair at 274 ms — an engine interval, not a
// human saying a weight twice.
//
// That matters because `transcribe.js`'s guard is keyed on the SLOT: `finalsByIndex[i] === transcript`
// drops a byte-identical re-delivery AT THE SAME INDEX. A duplicate at index 5 meets an empty slot,
// passes the guard untouched, and emits — while every downstream consumer appends what it receives.
// That is the doubled word ("Chinese Chinese", "bitter bitter melon") the fix was written for.
//
// THIS TEST IS THE MEASUREMENT, not the argument. It replays the device's exact index sequence
// through the REAL transcribe.js — no mock of the module under test — and counts emissions.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { installFakeSpeechRecognition } from './helpers/fakeSpeechRecognition.js'
import { startLiveTranscription } from '../lib/transcribe.js'

let mic

beforeEach(() => { mic = installFakeSpeechRecognition(vi) })
afterEach(() => { vi.unstubAllGlobals() })

function run(deliver) {
  const emitted = []
  startLiveTranscription({ onResult: (r) => { if (r.isFinal) emitted.push(r.transcript) } })
  const rec = mic.latest()
  deliver(rec)
  return emitted
}

describe('transcribe.js vs the duplicate the device actually emits', () => {
  it('drops a byte-identical re-delivery at the SAME slot (the shipped fix, still working)', () => {
    const emitted = run((rec) => {
      rec.deliverFinal('310 G', 4)
      rec.deliverFinal('310 G', 4)
    })
    expect(emitted).toEqual(['310 G'])
  })

  it('suppresses a REVISION at the same slot (VOICEDUPE-003, still working)', () => {
    const emitted = run((rec) => {
      rec.deliverFinal('310', 4)
      rec.deliverFinal('310 G', 4)
    })
    expect(emitted).toEqual(['310'])
  })

  // THE DEVICE SEQUENCE, verbatim from the 2026-08-27 log. This was CHARACTERIZATION when written
  // — it asserted ['310', '310 G', '310 G'] and passed — and the expectation flipping is the whole
  // record of the fix. The two assertions above did NOT change with it, which is the property that
  // says the original guard was extended rather than replaced.
  it('drops the same duplicate when it arrives at the NEXT slot', () => {
    const emitted = run((rec) => {
      rec.deliverFinal('310', 3)
      rec.deliverFinal('310 G', 4)
      rec.deliverFinal('310 G', 5)   // 272ms later on the device — a new index, same text
    })
    expect(emitted).toEqual(['310', '310 G'])
  })

  it('scans past the empty finals the device interleaves, not just slot i-1', () => {
    // The same run carried 9 empty finals among the real ones, so the slot immediately before a
    // duplicate is very often ''. A guard that only looked at i-1 would miss the real case.
    const emitted = run((rec) => {
      rec.deliverFinal('310 G', 4)
      rec.deliverFinal('', 5)
      rec.deliverFinal('', 6)
      rec.deliverFinal('310 G', 7)
    })
    expect(emitted.filter(Boolean)).toEqual(['310 G'])
  })

  it('does NOT drop a repeat with real speech in between', () => {
    // The scan stops at the first non-empty slot, so an intervening utterance breaks the comparison.
    // Two genuine "310 G" readings either side of a different value are two real values.
    const emitted = run((rec) => {
      rec.deliverFinal('310 G', 0)
      rec.deliverFinal('blueberries', 1)
      rec.deliverFinal('310 G', 2)
    })
    expect(emitted).toEqual(['310 G', 'blueberries', '310 G'])
  })

  it('leaves a DIFFERENT value at the next slot alone', () => {
    // The non-vacuity floor: a guard that dropped every next-slot final would pass the duplicate
    // tests above and silently eat half of what the user says.
    const emitted = run((rec) => {
      rec.deliverFinal('310 G', 4)
      rec.deliverFinal('2.5 cups', 5)
    })
    expect(emitted).toEqual(['310 G', '2.5 cups'])
  })
})
