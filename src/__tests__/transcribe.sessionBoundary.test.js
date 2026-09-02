// transcribe.js ACROSS a session boundary — gate B4, the wrapper's own start-path.
//
// B4 exists because the fakes this suite had did not model `onend` → `start()` → `onstart`, and the
// device proved that loop is the dominant path: Chrome Android ends a session after every utterance
// and re-arms in 16–133 ms. A fake without it cannot exercise anything that SPANS an utterance
// boundary — and every one of the wrapper's duplicate guards is scoped to one session, so the
// boundary is precisely where their coverage stops.
//
// transcribe.deviceDuplicate.test.js and transcribe.echoNormalisation.test.js already drive the real
// wrapper over the shared fake WITHIN one session. This file is the half neither of them can reach.
// Both behaviours pinned here are documented limits rather than defects; they are written down as
// tests so S2's `restartOnEnd` cannot quietly change them, and so the continuous hosts
// (VoiceHarvest, ContinuousVoiceProbe) have a stated reason for not routing through this wrapper.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { installFakeSpeechRecognition } from './helpers/fakeSpeechRecognition.js'
import { startLiveTranscription } from '../lib/transcribe.js'
import { isMicHeld, micHolder, resetMicArbiter } from '../lib/micArbiter.js'

let mic

beforeEach(() => {
  resetMicArbiter()
  mic = installFakeSpeechRecognition(vi)
})

afterEach(() => {
  resetMicArbiter()
  vi.unstubAllGlobals()
})

describe('transcribe.js — the echo guards are per SESSION, not per run', () => {
  it('suppresses a cross-slot echo inside one session', () => {
    const heard = []
    startLiveTranscription({ onResult: (r) => { if (r.isFinal) heard.push(r.transcript) } })
    expect(mic.instances.length).toBe(1)
    const rec = mic.latest()

    rec.deliverFinal('310 g', 0)
    rec.deliverFinal('310 g', 1)

    // The contrast the next test needs to mean anything: within a session the guard fires.
    expect(heard).toEqual(['310 g'])
  })

  it('delivers the SAME words again in the next session — the guard does not cross the re-arm', () => {
    const heard = []
    const arm = () => startLiveTranscription({ onResult: (r) => { if (r.isFinal) heard.push(r.transcript) } })

    arm()
    expect(mic.instances.length).toBe(1)
    mic.latest().deliverFinal('310 g', 0)
    mic.latest().endSession()

    // What a continuous host does inside its own onend, 16–133 ms later. `finalsByIndex` and
    // `lastFinal` are declared inside startLiveTranscription, so the new session starts blind.
    arm()
    expect(mic.instances.length).toBe(2)
    mic.latest().deliverFinal('310 g', 0)

    // NOT a defect to fix here. Closing it at this layer would mean a module-scoped `lastFinal`
    // shared by every surface in the app — Search's mic would start suppressing words because the
    // picker heard them. lib/voiceCommitDebounce.js's wall-clock cooldown is what covers the
    // crossing case, for the one consumer that re-arms.
    expect(heard).toEqual(['310 g', '310 g'])
  })
})

describe('transcribe.js — the mic hold does not span a re-arm', () => {
  it('is released at onend, BEFORE the caller can re-arm', () => {
    let heldWhenEndFired = null
    startLiveTranscription({
      debugLabel: 'Search',
      onEnd: () => { heldWhenEndFired = isMicHeld() },
    })
    expect(mic.instances.length).toBe(1)
    expect(micHolder()).toBe('Search')

    mic.latest().endSession()

    // The release happens in `onend` ahead of the endedFired guard, so by the time a host's onEnd
    // handler runs the mic is already free. That is the whole reason a re-arming host must take its
    // OWN hold for the length of the run instead of inheriting this one: routed through here, every
    // re-arm opens a window in which another surface can take the mic mid-sentence.
    expect(heldWhenEndFired).toBe(false)
    expect(isMicHeld()).toBe(false)
  })

  // micArbiter.test.js:49 already pins "a late release from an evicted owner cannot steal the mic"
  // against a hand-written stop callback. This is the same invariant through the REAL wrapper,
  // which is a different claim: the evicted owner's release is dispatched from transcribe.js's own
  // `onend`, reached synchronously from inside acquireMic while the new owner is already installed.
  // Nothing before this exercised that composition — it is the shape the token exists for.
  it('an evicted session’s own release cannot take the mic back from its new owner', () => {
    startLiveTranscription({ debugLabel: 'Search' })
    expect(mic.instances.length).toBe(1)
    const evicted = mic.latest()
    expect(micHolder()).toBe('Search')
    expect(evicted.started).toBe(true)

    // A second surface starts while the first is still LIVE. acquireMic installs the newcomer, then
    // runs the incumbent's stop() — so the incumbent's onend, and the releaseMic inside it, land
    // after the handover has already happened.
    startLiveTranscription({ debugLabel: 'Picker' })
    expect(mic.instances.length).toBe(2)

    expect(evicted.started).toBe(false)
    expect(mic.latest().started).toBe(true)
    expect(isMicHeld()).toBe(true)
    expect(micHolder()).toBe('Picker')
  })
})
