// BUG-VOICECOUNTSPLIT-001 — the decision-context tap on /log/voice.
//
// The load-bearing tests here are the two the existing recorder's own test file establishes as the
// bar for anything wired into a mic handler: INERT WHEN OFF (asserted with a result object whose
// `transcript` getter throws, because these taps format eagerly and a flag check that happens after
// the formatting is not a flag check), and NO NEW STORAGE (the tap must land in the one existing
// localStorage key so the privacy and retention argument made for the raw capture still covers it).
//
// The rest pin the discriminations the open defects actually need: a bare number spoken with a
// planting selected vs. without one produces the same classify() result and opposite behaviour, so
// the ctx line is the only thing that can tell those two runs apart in a captured trace.
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { installStoragePolyfill } from './helpers/storagePolyfill.js'

installStoragePolyfill()

import {
  describePlanting,
  describeValue,
  describePartial,
  formatContext,
  formatOutcome,
  tapVoiceContext,
  tapVoiceOutcome,
  tapVoiceNoMatch,
  VOICE_TAP_SRC,
} from '../lib/voiceDebugTap.js'
import {
  setVoiceDebugEnabled,
  readVoiceDebugLog,
  formatVoiceDebugLog,
  VOICE_DEBUG_LOG_KEY,
} from '../lib/voiceDebug.js'

const BIG_BOY = { id: 42, name: 'Big Boy', variety_ref: { name: 'Big Boy', crop_type_slug: 'tomato' } }

// A settled classify() result whose transcript detonates if anything reads it.
function boobyTrappedResult() {
  return {
    kind: 'search',
    get transcript() { throw new Error('read transcript while disabled') },
  }
}

beforeEach(() => {
  localStorage.clear()
})

describe('voiceDebugTap — inert when the toggle is off', () => {
  it('tapVoiceContext never reads the result while disabled', () => {
    expect(() => tapVoiceContext(boobyTrappedResult(), { selected: BIG_BOY })).not.toThrow()
    expect(tapVoiceContext(boobyTrappedResult(), { selected: BIG_BOY })).toBe(false)
  })

  it('no tap writes to storage while disabled', () => {
    const spy = vi.spyOn(localStorage, 'setItem')
    tapVoiceContext({ kind: 'search', transcript: 'three' }, { selected: null, held: null })
    tapVoiceOutcome('ok', 'Big Boy — now say the count or the weight.')
    tapVoiceNoMatch()
    expect(spy).not.toHaveBeenCalled()
    expect(readVoiceDebugLog()).toEqual([])
    spy.mockRestore()
  })

  it('every tap returns false while disabled', () => {
    expect(tapVoiceOutcome('ok', 'Saved Big Boy — 3 count')).toBe(false)
    expect(tapVoiceNoMatch('speech-timeout')).toBe(false)
  })
})

describe('voiceDebugTap — no storage location of its own', () => {
  it('writes into the one existing voiceDebug key and creates no other', () => {
    setVoiceDebugEnabled(true)
    tapVoiceContext({ kind: 'search', transcript: 'cucumber' }, {})
    tapVoiceOutcome('ok', 'Suyo Long — now say the count.')
    tapVoiceNoMatch()
    const keys = []
    for (let i = 0; i < localStorage.length; i++) keys.push(localStorage.key(i))
    // The flag key and the log key, and nothing else — no second bucket for decision context.
    expect(keys.filter((k) => k !== VOICE_DEBUG_LOG_KEY && !k.includes('voicedebug'))).toEqual([])
    expect(readVoiceDebugLog()).toHaveLength(3)
  })
})

describe('voiceDebugTap — the discriminations the count defect needs', () => {
  beforeEach(() => { setVoiceDebugEnabled(true) })

  it('separates a bare number with no planting selected from one with a planting selected', () => {
    // Identical utterance, identical classify() result. VoiceHarvest.jsx:464 gates the hold on a
    // planting being selected, so these two runs diverge entirely — and the existing `decision`
    // line is byte-identical for both.
    const said = { kind: 'search', text: 'three', transcript: 'three' }
    const searching = formatContext(said, { selected: null, held: null })
    const holding = formatContext(said, { selected: BIG_BOY, held: null })
    expect(searching).toContain('sel=-')
    expect(holding).toContain('sel=#42 "Big Boy"')
    expect(searching).not.toEqual(holding)
    // Both agree on what the grammar made of the words; only the state differs.
    expect(searching).toContain('partial=number:3')
    expect(holding).toContain('partial=number:3')
  })

  it('records a held number on every utterance, including the one that drops it', () => {
    // The clear at VoiceHarvest.jsx:474-479 emits no mark of its own, so the only trace a hold ever
    // existed is that the utterance which dropped it saw held=3 on the way in.
    const line = formatContext({ kind: 'unparsed', reason: 'near-command', transcript: 'text' },
      { selected: BIG_BOY, held: 3 })
    expect(line).toContain('held=3')
    expect(line).toContain('classify=unparsed:near-command')
  })

  it('records the classifyPartial answer for the unit half of a split count', () => {
    const line = formatContext({ kind: 'unparsed', reason: 'no-number', transcript: 'count' },
      { selected: BIG_BOY, held: 3 })
    expect(line).toContain('partial=unit:count')
  })

  it('records partial=- when classifyPartial declined, which is a real answer not a gap', () => {
    // A command is refused by classifyPartial on purpose (voiceHarvestGrammar.js:452-456) so a hold
    // can never eat "next". A trace that showed nothing here would read as "not consulted".
    const line = formatContext({ kind: 'command', command: 'save_and_advance', transcript: 'next' },
      { selected: BIG_BOY, held: 3 })
    expect(line).toContain('partial=-')
    expect(line).toContain('classify=command')
  })

  it('carries the record under construction, so an announced value that never landed is visible', () => {
    const line = formatContext({ kind: 'command', command: 'save_and_advance', transcript: 'next' },
      { selected: BIG_BOY, held: null, qty: { value: 3, unit: 'count' }, weight: { value: 15, unit: 'g' } })
    expect(line).toContain('qty=3 count')
    expect(line).toContain('wt=15 g')
  })

  it('quotes the transcript on every line', () => {
    expect(formatContext({ kind: 'search', transcript: 'suyo long' }, {})).toContain('<- "suyo long"')
  })

  it('survives a result object with nothing on it', () => {
    expect(() => formatContext(null, null)).not.toThrow()
    expect(formatContext(null, null)).toContain('classify=?')
    expect(formatContext(undefined, undefined)).toContain('sel=-')
  })
})

describe('voiceDebugTap — the outcome is the resulting action', () => {
  beforeEach(() => { setVoiceDebugEnabled(true) })

  it('distinguishes a committed save from a refused one, which classify() cannot', () => {
    // Both follow `command save_and_advance`. saveRecord refuses at VoiceHarvest.jsx:377 and commits
    // at :413, and the announcement is the only place those two diverge.
    const committed = formatOutcome('ok', 'Saved Big Boy — 3 count')
    const refused = formatOutcome('fail', 'Not saved — still need a quantity. Say it, then "next".')
    expect(committed).toContain('ok ')
    expect(refused).toContain('fail ')
    expect(committed).not.toEqual(refused)
  })

  it('records the tone and the exact words Dave saw', () => {
    tapVoiceOutcome('warn', '3 match "cucumber" — say more of the name, or tap one.')
    const log = readVoiceDebugLog()
    expect(log).toHaveLength(1)
    expect(log[0].kind).toBe('outcome')
    expect(log[0].src).toBe(VOICE_TAP_SRC)
    expect(log[0].detail).toContain('warn')
    expect(log[0].detail).toContain('3 match')
  })

  it('records an onnomatch lifecycle mark', () => {
    tapVoiceNoMatch()
    const log = readVoiceDebugLog()
    expect(log[0].kind).toBe('nomatch')
    expect(log[0].src).toBe(VOICE_TAP_SRC)
  })
})

describe('voiceDebugTap — the field helpers', () => {
  it('describePlanting keeps the id, because two plantings can share a name', () => {
    expect(describePlanting(BIG_BOY)).toBe('#42 "Big Boy"')
    expect(describePlanting({ id: 7, variety_ref: { name: 'Suyo Long' } })).toBe('#7 "Suyo Long"')
    expect(describePlanting(null)).toBe('-')
  })

  it('describeValue renders a slot or a dash', () => {
    expect(describeValue({ value: 3, unit: 'count' })).toBe('3 count')
    expect(describeValue(null)).toBe('-')
    expect(describeValue({ value: 0, unit: 'g' })).toBe('0 g')
  })

  it('describePartial names the kind and the payload', () => {
    expect(describePartial({ kind: 'number', value: 12 })).toBe('number:12')
    expect(describePartial({ kind: 'unit', unit: 'g' })).toBe('unit:g')
    expect(describePartial(null)).toBe('-')
  })
})

describe('voiceDebugTap — Dave can actually read it back', () => {
  it('the taps render through the existing /admin/voice-debug formatter', () => {
    // Point 4 of the brief: a trace is only evidence if the viewer shows it. formatVoiceDebugLog is
    // the exact function VoiceDebug.jsx:47 puts in the copyable textarea, so rendering through it
    // here is the same path Dave's Copy button takes.
    setVoiceDebugEnabled(true)
    tapVoiceContext({ kind: 'search', text: 'three', transcript: 'three' }, { selected: null, held: null })
    tapVoiceOutcome('fail', 'Nothing matched "three".')
    tapVoiceNoMatch()
    const text = formatVoiceDebugLog(readVoiceDebugLog())
    expect(text).toContain('voiceharvest  ctx sel=- held=-')
    expect(text).toContain('partial=number:3')
    expect(text).toContain('voiceharvest  outcome fail')
    expect(text).toContain('voiceharvest  nomatch')
    expect(text).not.toContain('(no events captured)')
  })

  it('a ctx line and the raw events it explains share one src column', () => {
    setVoiceDebugEnabled(true)
    tapVoiceContext({ kind: 'search', transcript: 'cucumber' }, {})
    expect(readVoiceDebugLog()[0].src).toBe('voiceharvest')
  })
})
