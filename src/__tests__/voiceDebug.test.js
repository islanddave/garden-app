// BUG-VOICEDUPE-002 — the raw-event recorder that turns the NEXT device test into ground truth.
//
// The load-bearing test in this file is the INERT-WHEN-OFF pin: the recorder is wired into the hot
// path of every speech handler in the app, so "off" must mean it never touches the live
// SpeechRecognitionResultList at all. That is asserted with an event whose `results` and
// `resultIndex` getters THROW — if any code path reads them while disabled, the test fails loudly
// rather than merely reporting a wasted allocation.
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { installStoragePolyfill } from './helpers/storagePolyfill.js'

installStoragePolyfill()

import {
  isVoiceDebugEnabled,
  setVoiceDebugEnabled,
  recordVoiceEvent,
  recordVoiceMark,
  readVoiceDebugLog,
  clearVoiceDebugLog,
  formatVoiceDebugLog,
  VOICE_DEBUG_FLAG_KEY,
  VOICE_DEBUG_LOG_KEY,
  VOICE_DEBUG_MAX_ENTRIES,
} from '../lib/voiceDebug.js'

function results(items) {
  return items.map((it) => {
    const r = [{ transcript: it.text, confidence: 0.9 }]
    r.isFinal = !!it.final
    return r
  })
}

// An event that detonates if anything inspects it.
function boobyTrappedEvent() {
  return {
    get resultIndex() { throw new Error('read resultIndex while disabled') },
    get results()     { throw new Error('read results while disabled') },
  }
}

beforeEach(() => {
  localStorage.clear()
})

describe('voiceDebug — inert when the toggle is off', () => {
  it('isVoiceDebugEnabled is false with no flag set', () => {
    expect(isVoiceDebugEnabled()).toBe(false)
  })

  it('recordVoiceEvent does not touch the event object at all when disabled', () => {
    expect(() => recordVoiceEvent('transcribe', boobyTrappedEvent())).not.toThrow()
    expect(recordVoiceEvent('transcribe', boobyTrappedEvent())).toBe(false)
  })

  it('recordVoiceEvent writes nothing to storage when disabled', () => {
    const spy = vi.spyOn(localStorage, 'setItem')
    recordVoiceEvent('transcribe', { resultIndex: 0, results: results([{ text: 'hi', final: true }]) })
    recordVoiceMark('transcribe', 'start')
    expect(spy).not.toHaveBeenCalled()
    expect(localStorage.getItem(VOICE_DEBUG_LOG_KEY)).toBe(null)
    expect(readVoiceDebugLog()).toEqual([])
    spy.mockRestore()
  })

  it('recordVoiceMark is a no-op when disabled', () => {
    expect(recordVoiceMark('transcribe', 'error', 'no-speech')).toBe(false)
    expect(readVoiceDebugLog()).toEqual([])
  })

  it('a flag value other than "1" counts as off', () => {
    localStorage.setItem(VOICE_DEBUG_FLAG_KEY, 'true')
    expect(isVoiceDebugEnabled()).toBe(false)
    expect(recordVoiceEvent('transcribe', boobyTrappedEvent())).toBe(false)
  })

  it('turning it off again stops recording and leaves the existing log readable', () => {
    setVoiceDebugEnabled(true)
    recordVoiceEvent('transcribe', { resultIndex: 0, results: results([{ text: 'kept', final: true }]) })
    setVoiceDebugEnabled(false)
    expect(recordVoiceEvent('transcribe', boobyTrappedEvent())).toBe(false)
    expect(readVoiceDebugLog()).toHaveLength(1)
  })
})

describe('voiceDebug — capture shape when enabled', () => {
  beforeEach(() => { setVoiceDebugEnabled(true) })

  it('captures resultIndex, results.length, and every result index/isFinal/transcript', () => {
    recordVoiceEvent('EventNew:notes', {
      resultIndex: 1,
      results: results([
        { text: 'water the tomatoes', final: true },
        { text: 'and the be', final: false },
      ]),
    })
    const [entry] = readVoiceDebugLog()
    expect(entry.kind).toBe('result')
    expect(entry.src).toBe('EventNew:notes')
    expect(entry.resultIndex).toBe(1)
    expect(entry.len).toBe(2)
    expect(entry.results).toEqual([
      { i: 0, final: true,  text: 'water the tomatoes' },
      { i: 1, final: false, text: 'and the be' },
    ])
    expect(typeof entry.t).toBe('number')
  })

  it('snapshots the list by index, so a growing cumulative list is recorded in full', () => {
    // Regression guard on the recorder itself: a spread/Array.from of a host SpeechRecognitionResultList
    // can come back empty, which would have made the whole diagnostic silently useless on device.
    const live = { length: 2, 0: Object.assign([{ transcript: 'a' }], { isFinal: true }),
                              1: Object.assign([{ transcript: 'b' }], { isFinal: false }) }
    recordVoiceEvent('transcribe', { resultIndex: 0, results: live })
    expect(readVoiceDebugLog()[0].results).toEqual([
      { i: 0, final: true,  text: 'a' },
      { i: 1, final: false, text: 'b' },
    ])
  })

  it('records lifecycle marks alongside results', () => {
    recordVoiceMark('transcribe', 'start')
    recordVoiceEvent('transcribe', { resultIndex: 0, results: results([{ text: 'x', final: true }]) })
    recordVoiceMark('transcribe', 'end', 'finalTranscript="x"')
    const log = readVoiceDebugLog()
    expect(log.map((e) => e.kind)).toEqual(['start', 'result', 'end'])
    expect(log[2].detail).toBe('finalTranscript="x"')
  })

  it('survives an event whose results throw — records an unreadable marker, never propagates', () => {
    expect(() => recordVoiceEvent('transcribe', boobyTrappedEvent())).not.toThrow()
    expect(readVoiceDebugLog()[0].kind).toBe('result-unreadable')
  })

  it('caps the log, keeping the NEWEST entries (the tail holds the duplication)', () => {
    for (let i = 0; i < VOICE_DEBUG_MAX_ENTRIES + 25; i++) recordVoiceMark('transcribe', 'mark', String(i))
    const log = readVoiceDebugLog()
    expect(log).toHaveLength(VOICE_DEBUG_MAX_ENTRIES)
    expect(log[log.length - 1].detail).toBe(String(VOICE_DEBUG_MAX_ENTRIES + 24))
  })

  it('clearVoiceDebugLog empties the log but leaves the toggle on', () => {
    recordVoiceMark('transcribe', 'start')
    clearVoiceDebugLog()
    expect(readVoiceDebugLog()).toEqual([])
    expect(isVoiceDebugEnabled()).toBe(true)
  })

  it('readVoiceDebugLog tolerates corrupt storage', () => {
    localStorage.setItem(VOICE_DEBUG_LOG_KEY, '{not json')
    expect(readVoiceDebugLog()).toEqual([])
    localStorage.setItem(VOICE_DEBUG_LOG_KEY, '{"a":1}')
    expect(readVoiceDebugLog()).toEqual([])
  })
})

describe('formatVoiceDebugLog — the block Dave copies', () => {
  it('reports emptiness plainly', () => {
    expect(formatVoiceDebugLog([])).toBe('(no events captured)')
  })

  it('renders one line per event plus one per result, with ms offsets from the first entry', () => {
    const t0 = 1_000_000
    const out = formatVoiceDebugLog([
      { t: t0, src: 'EventNew:notes', kind: 'start', detail: null },
      { t: t0 + 240, src: 'EventNew:notes', kind: 'result', resultIndex: 0, len: 2,
        results: [{ i: 0, final: true, text: 'water the tomatoes' }, { i: 1, final: false, text: 'and' }] },
    ])
    expect(out).toContain('EventNew:notes  start')
    expect(out).toContain('resultIndex=0 len=2')
    expect(out).toContain('[0] FINAL')
    expect(out).toContain('[1] interim')
    expect(out).toContain('"water the tomatoes"')
    expect(out).toContain('+   240')
  })

  it('reads the stored log when called with no argument', () => {
    setVoiceDebugEnabled(true)
    recordVoiceMark('transcribe', 'start')
    expect(formatVoiceDebugLog()).toContain('transcribe  start')
  })
})
