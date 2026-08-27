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

  // THE DEVICE SEQUENCE, verbatim from the 2026-08-27 log.
  it('does NOT drop the same duplicate when it arrives at the NEXT slot', () => {
    const emitted = run((rec) => {
      rec.deliverFinal('310', 3)
      rec.deliverFinal('310 G', 4)
      rec.deliverFinal('310 G', 5)   // 272ms later on the device — a new index, same text
    })
    // Documented as CHARACTERIZATION of today's behaviour, not as desired behaviour: the slot guard
    // is index-keyed, so index 5 is a fresh slot and the duplicate emits. A consumer that appends
    // therefore builds "310 G 310 G". If a fix lands, this expectation is what changes — and the
    // two assertions above are what must NOT change with it.
    expect(emitted).toEqual(['310', '310 G', '310 G'])
  })

  it('and the joined transcript carries the doubling too', () => {
    let last = null
    startLiveTranscription({ onResult: (r) => { if (r.isFinal) last = r } })
    const rec = mic.latest()
    rec.deliverFinal('310 G', 4)
    rec.deliverFinal('310 G', 5)
    expect(last.transcript).toBe('310 G')
    // The slots are re-joined whole on every final, so both entries are in the accumulated text.
    // This is the value a consumer reading the full transcript would show.
    expect(mic.latest()).toBeTruthy()
  })
})
