// OPS-VOICEDEBUGWIRE-001 — a CHARACTERIZATION test of the /log/voice capture dev ae83521 shipped.
//
// WHAT THIS FILE IS FOR, and what it deliberately is not. It adds no instrumentation. It drives the
// real page through the fake recogniser with capture ON and asserts what a trace pulled off Dave's
// phone would actually contain — because the disposition of three open rows turns on whether the
// existing capture is sufficient, and reading the source is not evidence of what a trace SAYS.
//
// If one of these goes red, the instrument changed and the answer below expired. That is the point:
// the assertions encode what a real trace can currently settle, so a later lane cannot quietly remove
// a field that a diagnosis depends on. Three questions, one describe block each:
//
//   (a) did the recogniser end BETWEEN a number and its unit  -> answerable, pinned below
//   (b) was a planting selected when a bare number arrived    -> answerable INDIRECTLY, and the limit
//                                                                is pinned as explicitly as the answer
//   (c) which recogniser error codes fire in the field        -> answerable, pinned below
//
// Same harness as VoiceHarvest.test.jsx (shared fake, api and haptics mocked) so the flow under test
// is the shipped one. RENDER assertions only, no jest-dom (L-182).
import React from 'react'
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, fireEvent, act, waitFor } from '@testing-library/react'
import { installFakeSpeechRecognition } from './helpers/fakeSpeechRecognition.js'
import { installStoragePolyfill } from './helpers/storagePolyfill.js'

installStoragePolyfill()

const { apiFetchSpy } = vi.hoisted(() => ({ apiFetchSpy: vi.fn() }))
vi.mock('../lib/api.js', () => ({ useApiFetch: () => ({ fetch: apiFetchSpy, getToken: vi.fn() }) }))
vi.mock('../lib/haptics.js', () => ({
  hapticSaveCommitted: vi.fn(), hapticSaveFailed: vi.fn(),
  hapticDigitAccepted: vi.fn(), hapticDigitRejected: vi.fn(), hapticUndoApplied: vi.fn(),
}))

import VoiceHarvest from '../pages/VoiceHarvest.jsx'
import VoiceDebug from '../pages/VoiceDebug.jsx'
import { setVoiceDebugEnabled, readVoiceDebugLog, formatVoiceDebugLog } from '../lib/voiceDebug.js'

const planting = (id, name, slug) => ({
  id, name, archived_at: null,
  variety_ref: { id: `v-${id}`, name: `${name} cultivar`, crop_type_slug: slug, default_unit: null },
})

const PLANTS = [
  planting('p1', 'Suyo Long', 'cucumber'),
  planting('p2', 'Marketmore', 'cucumber'),
]

let mic

beforeEach(() => {
  localStorage.clear()
  setVoiceDebugEnabled(true)
  mic = installFakeSpeechRecognition(vi)
  apiFetchSpy.mockReset()
  apiFetchSpy.mockImplementation((url) => {
    if (String(url).startsWith('/api/plants')) return Promise.resolve({ plants: PLANTS })
    return Promise.resolve({ eventId: 'evt-1' })
  })
})
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks() })

async function startListening() {
  render(<VoiceHarvest />)
  await waitFor(() => expect(apiFetchSpy).toHaveBeenCalled())
  await act(async () => { fireEvent.click(screen.getByTestId('voice-harvest-toggle')) })
  return mic.latest()
}

// One utterance that settles at the session boundary, which is the device's dominant path.
async function speak(rec, text) {
  await act(async () => { rec.deliverFinal(text) })
  await act(async () => { rec.endSession() })
}

// The trace as Dave would paste it — the same function VoiceDebug.jsx:47 puts in the textarea.
const trace = () => formatVoiceDebugLog(readVoiceDebugLog())
const kinds = () => readVoiceDebugLog().filter((e) => e.src === 'voiceharvest').map((e) => e.kind)
const decisions = () =>
  readVoiceDebugLog().filter((e) => e.kind === 'decision').map((e) => e.detail)

describe('(a) did the recogniser end between a number and its unit', () => {
  it('the session boundary is recorded BETWEEN the two halves, in order', async () => {
    // This is the exact failure ae83521 describes: "three" / sessionEnd / "count". A trace can only
    // settle it if the `end` mark falls between the two result events rather than after both.
    const rec = await startListening()
    await speak(rec, 'suyo long')
    await speak(rec, 'three')
    await speak(rec, 'count')

    const seq = kinds()
    // start, then per utterance: result -> decision -> end -> start (the re-arm).
    const firstResult = seq.indexOf('result')
    expect(firstResult).toBeGreaterThanOrEqual(0)
    expect(seq.filter((k) => k === 'end').length).toBe(3)
    expect(seq.filter((k) => k === 'start').length).toBe(4)   // arm + one re-arm per boundary

    // The load-bearing ordering: the number's result, then an end, then a start, then the unit's.
    const text = trace()
    const iThree = text.indexOf('"three"')
    const iCount = text.indexOf('"count"')
    const iEnd = text.indexOf('voiceharvest  end', iThree)
    expect(iThree).toBeGreaterThan(-1)
    expect(iCount).toBeGreaterThan(iThree)
    expect(iEnd).toBeGreaterThan(iThree)
    expect(iEnd).toBeLessThan(iCount)
  })

  it('INTERIM results are captured too, so a unit heard-then-dropped is visible', async () => {
    // The debouncer only ever sees finals (VoiceHarvest.jsx:677 skips !isFinal), so an interim that
    // carried the unit and was then revised away exists ONLY in the raw capture. That is the one
    // place a trace can show the engine did hear "count" before the boundary took it.
    const rec = await startListening()
    await act(async () => { rec.deliverInterim('three coun') })
    await act(async () => { rec.deliverFinal('three', 0) })
    await act(async () => { rec.endSession() })
    expect(trace()).toContain('interim "three coun"')
    expect(trace()).toContain('FINAL   "three"')
  })

  it('the same two words inside ONE session leave no boundary between them', async () => {
    // The control. Without this, an `end` mark somewhere in the log proves nothing — a trace has to
    // distinguish the split run from the intact one, and this is the run that must NOT show a break.
    const rec = await startListening()
    await speak(rec, 'suyo long')
    await act(async () => { rec.deliverFinal('three') })
    await act(async () => { rec.deliverFinal('three count') })
    await act(async () => { rec.endSession() })

    const text = trace()
    const iThree = text.indexOf('"three"')
    const iJoined = text.indexOf('"three count"')
    expect(iThree).toBeGreaterThan(-1)
    expect(iJoined).toBeGreaterThan(iThree)
    expect(text.slice(iThree, iJoined)).not.toContain('voiceharvest  end')
  })
})

describe('(b) was a planting selected when a bare number arrived', () => {
  it('ANSWERABLE: the decision line names the branch, and the two branches differ', async () => {
    // BUG-VOICEBARENUMNOSEL-001. With a planting selected, VoiceHarvest.jsx:464 holds the number and
    // writes `held-number`. With none selected the same utterance falls through to the search branch
    // at :522 and writes `search`. So a trace CAN be counted for how often the bad ordering happened.
    const rec = await startListening()
    await speak(rec, 'three')                      // no planting selected yet — the defect ordering
    const beforeSelection = decisions()
    expect(beforeSelection.some((d) => d.startsWith('search'))).toBe(true)
    expect(beforeSelection.some((d) => d.startsWith('held-number'))).toBe(false)

    await speak(rec, 'suyo long')
    await speak(rec, 'three')                      // same words, planting now selected
    const after = decisions()
    expect(after.some((d) => d.startsWith('held-number 3'))).toBe(true)
  })

  it('LIMIT: the trace does not name which planting a bare number reselected', async () => {
    // The gap that decides whether OPS-VOICEDEBUGWIRE-001 closes outright. The search branch records
    // the words but no mark is written for the SELECTION it then makes (:548-568), so a trace shows
    // that a bare number went searching and not which plant it landed on. The wrong-plant save is
    // still reconstructable — the following `end`/save announcement carries the name — but not from
    // the decision line alone.
    const rec = await startListening()
    await speak(rec, 'three')
    const searchLine = decisions().find((d) => d.startsWith('search'))
    expect(searchLine).toContain('"three"')
    expect(searchLine).not.toContain('Suyo Long')
    expect(searchLine).not.toContain('p1')
    // And no separate mark records the outcome of that search.
    expect(kinds()).not.toContain('outcome')
  })

  it('LIMIT: a bare number that matched nothing is indistinguishable in KIND from one that matched', async () => {
    // Both write `search <text>`. Only the on-screen announcement differed, and that is not captured.
    const rec = await startListening()
    await speak(rec, 'three')
    await speak(rec, 'rhubarb')
    const lines = decisions().filter((d) => d.startsWith('search'))
    expect(lines.length).toBe(2)
    expect(lines.every((d) => /^search /.test(d))).toBe(true)
  })
})

describe('(c) which recogniser error codes fire in the field', () => {
  it('the error CODE is recorded verbatim, not just that an error happened', async () => {
    const rec = await startListening()
    await act(async () => { rec.deliverError('no-speech') })
    await act(async () => { rec.deliverError('network') })
    const errs = readVoiceDebugLog().filter((e) => e.kind === 'error').map((e) => e.detail)
    expect(errs).toEqual(['no-speech', 'network'])
    expect(trace()).toContain('voiceharvest  error no-speech')
  })

  it('GAP: onnomatch is not wired, so speech that produced no result looks like silence', async () => {
    // Pinned as a KNOWN ABSENCE rather than left implicit. Chrome fires onnomatch rarely, but the
    // number half of a split count going missing has exactly this shape, and a trace currently
    // cannot distinguish "spoke and the engine returned nothing" from "said nothing".
    const rec = await startListening()
    await act(async () => { rec.onnomatch?.({}) })
    expect(kinds()).not.toContain('nomatch')
  })
})

describe('a trace captured on /log/voice reaches Dave through the existing viewer', () => {
  it('shows up in the /admin/voice-debug textarea after being captured on the harvest page', async () => {
    // The whole instrument is worthless if the output cannot be retrieved on an Android PWA. The
    // capture happens on one route and is read on another, which is why VoiceDebug.jsx re-reads on
    // focus; here the second render is that navigation.
    const rec = await startListening()
    await speak(rec, 'suyo long')
    await speak(rec, 'three')

    const captured = readVoiceDebugLog().length
    expect(captured).toBeGreaterThan(0)

    render(<VoiceDebug />)
    const shown = screen.getByTestId('voice-debug-text').value
    expect(shown).toContain('voiceharvest')
    expect(shown).toContain('"suyo long"')
    expect(shown).toContain('held-number 3')
    expect(shown).not.toBe('(no events captured)')
    expect(screen.getByTestId('voice-debug-count').textContent).toContain(`${captured} entr`)
  })

  it('the Copy button exports the SAME text the textarea shows — the export round-trips', async () => {
    const rec = await startListening()
    await speak(rec, 'suyo long')

    const writeText = vi.fn().mockResolvedValue(undefined)
    vi.stubGlobal('navigator', { ...navigator, clipboard: { writeText } })

    render(<VoiceDebug />)
    const shown = screen.getByTestId('voice-debug-text').value
    await act(async () => { fireEvent.click(screen.getByTestId('voice-debug-copy')) })

    expect(writeText).toHaveBeenCalledTimes(1)
    expect(writeText.mock.calls[0][0]).toBe(shown)
    // And the exported text really carries the harvest-page capture, not an empty placeholder.
    expect(writeText.mock.calls[0][0]).toContain('voiceharvest')
    expect(writeText.mock.calls[0][0]).toContain('"suyo long"')
  })

  it('capture OFF on the harvest page leaves the viewer empty — the flag is the whole gate', async () => {
    setVoiceDebugEnabled(false)
    const rec = await startListening()
    await speak(rec, 'suyo long')
    await speak(rec, 'three')

    expect(readVoiceDebugLog()).toEqual([])
    render(<VoiceDebug />)
    expect(screen.getByTestId('voice-debug-text').value).toBe('(no events captured)')
  })
})
