// Voice capture SURVIVAL and HONEST FAILURE — the four rows that close the /log/voice family.
//
//   BUG-VOICESCREENSLEEP-001   the screen going dark kills capture and every cue at once
//   OPS-VOICENOMATCH-001       the engine saying "I heard it and could not place it" was unwired
//   BUG-VOICEWEIGHTLESSNOTE-001 a save with no weight announced plain success
//   BUG-VOICEFAILSILENT-001 R3/R4  the strip counts misses; a refused cue is reported
//
// WHY THESE ARE IN THEIR OWN FILE rather than appended to VoiceHarvest.test.jsx: that suite mocks
// the haptics module to `vi.fn()` (undefined return), which is exactly right for asserting WHICH cue
// fired and exactly wrong for R4, whose whole subject is the value a cue RETURNS. Mocks are
// per-file, so a file that needs `haptic()` to answer `false` cannot share one with a file that
// needs it to answer nothing.
//
// The recogniser is driven through the SHARED fake (helpers/fakeSpeechRecognition.js), which models
// the `onend -> start -> onstart` re-arm loop the device proved is the dominant path.
import React from 'react'
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, fireEvent, act, waitFor } from '@testing-library/react'
import { installFakeSpeechRecognition } from './helpers/fakeSpeechRecognition.js'

const { apiFetchSpy } = vi.hoisted(() => ({ apiFetchSpy: vi.fn() }))
vi.mock('../lib/api.js', () => ({ useApiFetch: () => ({ fetch: apiFetchSpy, getToken: vi.fn() }) }))
// Every wrapper returns TRUE by default — the honest default, since `haptic()` returns true only on
// acceptance and a platform that accepted is the ordinary case. The refusal tests below flip one
// wrapper to `false` per test, which is the only thing the page can read.
vi.mock('../lib/haptics.js', () => ({
  hapticSaveCommitted: vi.fn(() => true), hapticSaveFailed: vi.fn(() => true),
  hapticDigitAccepted: vi.fn(() => true), hapticDigitRejected: vi.fn(() => true),
  hapticUndoApplied: vi.fn(() => true), hapticMatchUncertain: vi.fn(() => true),
}))
import * as haptics from '../lib/haptics.js'

import VoiceHarvest from '../pages/VoiceHarvest.jsx'

const planting = (id, name, slug, unit = null) => ({
  id, name, archived_at: null,
  variety_ref: { id: `v-${id}`, name: `${name} cultivar`, crop_type_slug: slug, default_unit: unit },
})
const PLANTS = [planting('p1', 'Suyo Long', 'cucumber'), planting('p2', 'Marketmore', 'cucumber')]

const EVENT_ID = '9c4b1f2e-6a7d-4f10-8b33-5d2e0a71c4ab'
const createdEvent = () => ({ id: EVENT_ID, event_type: 'harvest', plant_id: 'p1' })

let mic

beforeEach(() => {
  mic = installFakeSpeechRecognition(vi)
  for (const h of Object.values(haptics)) h.mockClear?.()
  apiFetchSpy.mockReset()
  apiFetchSpy.mockImplementation((url) => (String(url).startsWith('/api/plants')
    ? Promise.resolve({ plants: PLANTS })
    : Promise.resolve(createdEvent())))
})
afterEach(() => {
  delete navigator.wakeLock
  delete document.visibilityState
  delete document.hidden
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

// jsdom exposes `visibilityState`/`hidden` as prototype getters, so an own property shadows them for
// the life of the test and `delete` in afterEach puts the real ones back. Both are set because the
// page reads both — an environment where they disagree is treated as hidden, which is the safe way
// round, and a test that stubbed only one would not prove which one the code actually consults.
function setHidden(hidden) {
  Object.defineProperty(document, 'visibilityState', {
    configurable: true, get: () => (hidden ? 'hidden' : 'visible'),
  })
  Object.defineProperty(document, 'hidden', { configurable: true, get: () => hidden })
}
const fireVisibility = async () => {
  await act(async () => { document.dispatchEvent(new Event('visibilitychange')) })
}
const goHidden  = async () => { setHidden(true);  await fireVisibility() }
const goVisible = async () => { setHidden(false); await fireVisibility() }

function stubWakeLock(request) {
  Object.defineProperty(navigator, 'wakeLock', { configurable: true, value: { request } })
}
const sentinel = () => ({ release: vi.fn(() => Promise.resolve()) })

async function startListening() {
  render(<VoiceHarvest />)
  await waitFor(() => expect(apiFetchSpy).toHaveBeenCalled())
  await act(async () => { fireEvent.click(screen.getByTestId('voice-harvest-toggle')) })
  return mic.latest()
}
async function speak(rec, text) {
  await act(async () => { rec.deliverFinal(text) })
  await act(async () => { rec.endSession() })
}
const statusText = () => screen.getByTestId('voice-harvest-status').textContent
const ledgerText = () => screen.getByTestId('voice-harvest-ledger').textContent
const screenNote = () => screen.queryByTestId('voice-harvest-screen')?.textContent ?? ''
const misses = () => screen.queryAllByTestId('voice-harvest-miss').map((n) => n.textContent)
const notes  = () => screen.queryAllByTestId('voice-harvest-note').map((n) => n.textContent)
const harvestPosts = () =>
  apiFetchSpy.mock.calls.filter(([url, opts]) => url === '/api/events' && opts?.method === 'POST')

describe('BUG-VOICESCREENSLEEP-001 — the screen going dark', () => {
  it('holds a screen wake lock for the run and releases it on Stop', async () => {
    // The lock is the PRECONDITION for the three-channel design, not an optimisation: hidden, Chrome
    // aborts recognition on Android AND refuses navigator.vibrate AND the banner is on a dark screen.
    const s = sentinel()
    const request = vi.fn(async () => s)
    stubWakeLock(request)

    await startListening()
    await waitFor(() => expect(request).toHaveBeenCalledWith('screen'))
    await waitFor(() => expect(screenNote()).toContain('held awake'))

    await act(async () => { fireEvent.click(screen.getByTestId('voice-harvest-toggle')) })
    expect(s.release).toHaveBeenCalled()
    // The claim goes away with the lock — a stale "screen held awake" after the run is over is the
    // same lie in the other direction.
    expect(screenNote()).toBe('')
  })

  it('degrades without throwing when the browser has no Wake Lock, and SAYS the screen may sleep', async () => {
    // Absent on some browsers and in every insecure context. The mic must still start; the user must
    // not be told the screen is being held when it is not.
    const rec = await startListening()
    expect(rec.started).toBe(true)
    await waitFor(() => expect(screenNote()).toContain('will not hold the screen awake'))
  })

  it('says so when the request is REFUSED rather than assuming it held', async () => {
    // A wake lock can be refused at request time (low battery). Reading the promise is the whole
    // difference between an honest degradation and a silent one.
    stubWakeLock(vi.fn(() => Promise.reject(new Error('low battery'))))
    const rec = await startListening()
    expect(rec.started).toBe(true)
    await waitFor(() => expect(screenNote()).toContain('may sleep'))
    expect(screenNote()).toContain('low battery')
  })

  it('does NOT re-arm the recogniser against a hidden document', async () => {
    // THE DEFECT: Chrome aborts on hide, `onend` re-armed, Chrome aborted again — the loop burned the
    // 600-restart budget and then reported "session limit reached", a message describing a time
    // budget for a failure that was nothing of the kind.
    const rec = await startListening()
    expect(rec.startCount).toBe(1)

    // Visible: the re-arm is what makes the page hands-free, and it must keep working.
    await act(async () => { rec.endSession() })
    expect(rec.startCount).toBe(2)

    // Hidden WITHOUT our listener having run yet — Chrome's abort can land first, and the guard has
    // to hold on `onend`'s own reading rather than on the listener having tidied up.
    setHidden(true)
    await act(async () => { rec.endSession() })
    expect(rec.startCount).toBe(2)
    expect(misses().join(' ')).toContain('screen went off')
  })

  it('treats an ABORTED error as a real failure when hidden, and as routine when visible', async () => {
    // 'aborted' is what the platform emits for this, and the page used to swallow it as ordinary —
    // which is precisely how a dead session looked like a live one. The visible half is the
    // non-vacuity control: aborted IS ordinary when we are the ones aborting.
    const rec = await startListening()
    await act(async () => { rec.deliverError('aborted') })
    expect(misses()).toHaveLength(0)
    expect(haptics.hapticSaveFailed).not.toHaveBeenCalled()

    setHidden(true)
    await act(async () => { rec.deliverError('aborted') })
    expect(misses().join(' ')).toContain('screen went off')
    expect(haptics.hapticSaveFailed).toHaveBeenCalled()
  })

  it('announces the interruption ONCE however many events notice it', async () => {
    // Chrome's `aborted`, the visibilitychange listener and `onend` can all arrive for one screen
    // timeout. Three rows for one event would make the count in the header untrustworthy, which is
    // the thing the header exists to be.
    const rec = await startListening()
    setHidden(true)
    await act(async () => { rec.deliverError('aborted') })
    await fireVisibility()
    await act(async () => { rec.endSession() })
    expect(misses()).toHaveLength(1)
  })

  it('re-acquires the lock and re-arms when the page comes back', async () => {
    const request = vi.fn(async () => sentinel())
    stubWakeLock(request)
    await startListening()
    await waitFor(() => expect(request).toHaveBeenCalledTimes(1))

    await goHidden()
    expect(mic.latest().started).toBe(false)

    await goVisible()
    // A fresh request, because the platform released the old lock on hide — that is spec behaviour,
    // so a lock acquired once and assumed to persist stops working the first time he takes a call.
    expect(request).toHaveBeenCalledTimes(2)
    expect(mic.instances).toHaveLength(2)
    expect(mic.latest().started).toBe(true)
    expect(statusText()).toContain('Listening again now')
  })
})

describe('OPS-VOICENOMATCH-001 — the engine says it heard nothing usable', () => {
  it('announces it on all three channels instead of dropping it', async () => {
    const rec = await startListening()
    await act(async () => { rec.onnomatch({}) })
    expect(statusText()).toContain('could not make it out')
    expect(misses().join(' ')).toContain('could not make it out')
    // The SOFT-REJECT cue, not the terminal one: nomatch does not end capture, and claiming the mic
    // died when it did not would be its own dishonesty.
    expect(haptics.hapticDigitRejected).toHaveBeenCalled()
    expect(haptics.hapticSaveFailed).not.toHaveBeenCalled()
  })
})

describe('BUG-VOICEWEIGHTLESSNOTE-001 — a save with no weight', () => {
  it('says NO WEIGHT on the banner and in the row, and still saves', async () => {
    // 1,079 of 1,080 prod harvests carry a weight, so a weightless row is far likelier to be a
    // capture failure than an intention. A NOTE, NEVER A GATE — the payload is untouched.
    vi.useFakeTimers({ shouldAdvanceTime: true })
    const rec = await startListening()
    await speak(rec, 'Suyo Long')
    await speak(rec, 'three count')
    await speak(rec, 'next')
    await act(async () => { await vi.advanceTimersByTimeAsync(1200) })

    expect(harvestPosts()).toHaveLength(1)
    const body = JSON.parse(harvestPosts()[0][1].body)
    expect(body.harvest).toEqual({ quantity: 3, unit: 'count', quality_rating: null })
    expect(statusText()).toContain('no weight was said')
    // Durable, not just on the banner: the banner is the channel the next utterance overwrites, and
    // a weightless row is exactly a thing to reconcile at the end of the session.
    expect(ledgerText()).toContain('no weight was said')
    vi.useRealTimers()
  })

  it('sends NO is_public key at all — the silent-client contract (BUG-EVENTPUBFALSE-001)', async () => {
    // This page sent `is_public: false` on every harvest. V4-PUBHIDE-001 is "default everything to
    // true on all create paths" and the Lambda implements it as `body.is_public ?? true` — but
    // `false ?? true` is `false`, so an explicit false wins all the way to the row, and
    // lambda/projects/index.js:194 then filters the harvest out of the public garden page with
    // `AND is_public IS TRUE`. V4-PUBHIDE-001 removed every is_public toggle from the UI, so there
    // was no surface on which to notice or undo it.
    //
    // ASSERTED AS ABSENCE OF THE KEY, not as `=== true`. A `true` would pass an equality test and
    // still be the same defect one default-change later; staying silent is the contract.
    vi.useFakeTimers({ shouldAdvanceTime: true })
    const rec = await startListening()
    await speak(rec, 'Suyo Long')
    await speak(rec, 'three count')
    await speak(rec, 'next')
    await act(async () => { await vi.advanceTimersByTimeAsync(1200) })

    expect(harvestPosts()).toHaveLength(1)
    const body = JSON.parse(harvestPosts()[0][1].body)
    expect(Object.keys(body)).not.toContain('is_public')
    // Non-vacuity for the assertion itself: this body IS the create body, and it does carry the
    // sibling keys — so "no is_public" is a fact about the payload, not about an empty object.
    expect(Object.keys(body)).toEqual(expect.arrayContaining(['plant_id', 'event_type', 'harvest']))
    vi.useRealTimers()
  })

  it('says nothing of the kind when a weight WAS spoken', async () => {
    // Non-vacuity for the pair above. A note that fired on every save would mean nothing by the
    // second bed, and would make the count-only case invisible again.
    vi.useFakeTimers({ shouldAdvanceTime: true })
    const rec = await startListening()
    await speak(rec, 'Suyo Long')
    await speak(rec, 'three count')
    await speak(rec, '231 grams')
    await speak(rec, 'next')
    await act(async () => { await vi.advanceTimersByTimeAsync(1200) })

    expect(statusText()).toContain('231 g')
    expect(statusText()).not.toContain('no weight')
    expect(ledgerText()).not.toContain('no weight')
    vi.useRealTimers()
  })
})

describe('BUG-VOICEFAILSILENT-001 R3 — the strip counts what was NOT captured', () => {
  it('reads "1 saved · 2 not captured" after a save and two refusals', async () => {
    // The banner is one slot and `say()` replaces it, so each of those refusals was announced once
    // and erased by the next utterance. This line is the only surface that can still answer "did
    // everything I said get logged?" minutes later.
    vi.useFakeTimers({ shouldAdvanceTime: true })
    const rec = await startListening()
    await speak(rec, 'Suyo Long')
    await speak(rec, 'three count')
    await speak(rec, 'next')
    await act(async () => { await vi.advanceTimersByTimeAsync(1200) })
    expect(ledgerText()).toContain('1 saved')

    await speak(rec, 'rhubarb')            // nothing matched
    await speak(rec, 'blah blah blah')     // didn't catch that
    expect(ledgerText()).toContain('1 saved · 2 not captured')
    // The heard text travels with the row: recovery from a mishear means knowing WHAT it heard.
    expect(misses().join(' ')).toContain('rhubarb')
    vi.useRealTimers()
  })

  it('counts nothing on a clean session — the second half appears only when there is one', async () => {
    // Non-vacuity. A header that always said "· 0 not captured" would be noise on every glance, and
    // a counter that increments on ordinary successes would be worse than none.
    vi.useFakeTimers({ shouldAdvanceTime: true })
    const rec = await startListening()
    await speak(rec, 'Suyo Long')
    await speak(rec, 'three count')
    await speak(rec, 'next')
    await act(async () => { await vi.advanceTimersByTimeAsync(1200) })
    expect(ledgerText()).toContain('1 saved')
    expect(ledgerText()).not.toContain('not captured')
    expect(misses()).toHaveLength(0)
    vi.useRealTimers()
  })

  it('does NOT count an ambiguous match as a miss — it is a question, not a loss', async () => {
    // Deliberate scope call: the candidate list stays on screen and is normally resolved by the next
    // utterance, so counting it would inflate the number with things that were captured a second
    // later. A count that overstates is a count he stops reading.
    const rec = await startListening()
    await speak(rec, 'cucumber')
    expect(statusText()).toContain('2 match')
    expect(misses()).toHaveLength(0)
    expect(ledgerText()).not.toContain('not captured')
  })
})

describe('BUG-VOICEFAILSILENT-001 R4 — a cue the platform REFUSED', () => {
  it('reports the refusals once, when the page next becomes visible', async () => {
    // The failure of the failure-detector. `haptic()` returns true only on acceptance, and Chrome
    // refuses on a hidden document and drops the request outright on ringer-silent — the pocketed
    // phone this vocabulary was designed for is exactly where the channel is dead. Saying so is what
    // turns an unfixable hole into an honest one.
    haptics.hapticDigitRejected.mockReturnValue(false)
    const rec = await startListening()
    await speak(rec, 'rhubarb')
    await speak(rec, 'parsnip')
    expect(haptics.hapticDigitRejected).toHaveBeenCalledTimes(2)
    // Nothing is said while it is happening: the report is worthless on a screen nobody is looking
    // at, and the moment it becomes readable is the moment it is worth spending.
    expect(notes()).toHaveLength(0)

    // Stopped BEFORE the page hides, so this exercises the refusal report on its own. Hiding a
    // RUNNING session is the screen-sleep path, which legitimately takes the banner for the more
    // urgent message — that interaction is asserted in the screen-sleep block above.
    await act(async () => { fireEvent.click(screen.getByTestId('voice-harvest-toggle')) })
    await goHidden()
    await goVisible()
    expect(notes().join(' ')).toContain('did not buzz for 2 cues')
    expect(statusText()).toContain('did not buzz')

    // ONCE. A counter that never resets would re-report the same two refusals every time he came
    // back to the page.
    await goHidden()
    await goVisible()
    expect(notes()).toHaveLength(1)
  })

  it('says nothing when every cue was ACCEPTED', async () => {
    // Non-vacuity: the wrappers return true by default here, so a report that appeared anyway would
    // be reporting the fact that a cue fired rather than the fact that one was refused.
    const rec = await startListening()
    await speak(rec, 'rhubarb')
    expect(haptics.hapticDigitRejected).toHaveBeenCalled()
    await goHidden()
    await goVisible()
    expect(notes()).toHaveLength(0)
  })

  it('keeps the refusal count OUT of the "not captured" total', async () => {
    // Two different facts that must not be added together: a miss is a spoken thing that did not
    // become data, a refused cue is a channel that did not reach him. Folding one into the other
    // would make the header mean two things at once.
    haptics.hapticDigitRejected.mockReturnValue(false)
    const rec = await startListening()
    await speak(rec, 'rhubarb')
    await act(async () => { fireEvent.click(screen.getByTestId('voice-harvest-toggle')) })
    await goHidden()
    await goVisible()
    expect(notes()).toHaveLength(1)
    expect(ledgerText()).toContain('0 saved · 1 not captured')
  })
})
