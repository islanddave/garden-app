// BUG-VOICEDUPE-002 — createFinalResultReader against the RAW SpeechRecognitionEvent shape.
//
// Everything here builds a CUMULATIVE results list and an explicit resultIndex, because that is what
// the browser dispatches. The prior fix's tests drove `onResult({transcript, isFinal})` — an
// already-normalized shape invented by our own wrapper — so they could not express the event
// patterns that actually cause duplication. These can.
import { describe, it, expect } from 'vitest'
import { createFinalResultReader } from '../lib/voiceResults.js'

// Models SpeechRecognitionResultList: an indexed, array-like collection of SpeechRecognitionResult,
// each of which is itself indexed (alternatives) and carries .isFinal.
function results(items) {
  const list = items.map((it) => {
    const r = [{ transcript: it.text, confidence: it.confidence ?? 0.9 }]
    r.isFinal = !!it.final
    return r
  })
  list.length = items.length
  return list
}

const ev = (resultIndex, items) => ({ resultIndex, results: results(items) })

describe('createFinalResultReader — raw Web Speech event contract', () => {
  it('emits a single final once', () => {
    const read = createFinalResultReader()
    expect(read(ev(0, [{ text: 'watered the tomatoes', final: true }])))
      .toEqual(['watered the tomatoes'])
  })

  it('interim→final promotion at the SAME index emits the text exactly once', () => {
    // Chrome Android's normal cadence: index 0 grows as interim, then flips isFinal at index 0.
    // A handler that committed interims (or that re-read index 0 on the final) would emit twice.
    const read = createFinalResultReader()
    expect(read(ev(0, [{ text: 'watered', final: false }]))).toEqual([])
    expect(read(ev(0, [{ text: 'watered the', final: false }]))).toEqual([])
    expect(read(ev(0, [{ text: 'watered the tomatoes', final: false }]))).toEqual([])
    expect(read(ev(0, [{ text: 'watered the tomatoes', final: true }]))).toEqual(['watered the tomatoes'])
  })

  it('does NOT re-emit an already-consumed final when a later event carries the cumulative list', () => {
    // THE BUG. event.results is cumulative; a second utterance arrives with the FIRST still in the
    // list. Reading a fixed index — or re-walking the whole list — appends "water the tomatoes" twice.
    const read = createFinalResultReader()
    expect(read(ev(0, [{ text: 'water the tomatoes', final: true }]))).toEqual(['water the tomatoes'])
    const second = read(ev(1, [
      { text: 'water the tomatoes', final: true },
      { text: 'and the beans', final: true },
    ]))
    expect(second).toEqual(['and the beans'])
  })

  it('ignores a resultIndex that points BACKWARDS at a settled final (Chrome revises finals)', () => {
    // resultIndex is the first CHANGED result, not the first NEW one. Chrome re-dispatches index 0
    // with revised capitalization/punctuation. Honoring resultIndex as the loop's lower bound — which
    // is the intuitive reading of the spec — re-appends the whole phrase.
    const read = createFinalResultReader()
    expect(read(ev(0, [{ text: 'harvested six beans', final: true }]))).toEqual(['harvested six beans'])
    const revised = read(ev(0, [
      { text: 'Harvested 6 beans.', final: true },     // SAME index, DIFFERENT text
      { text: 'and two peppers', final: true },
    ]))
    expect(revised).toEqual(['and two peppers'])
    expect(revised.join(' ')).not.toMatch(/beans.*beans/)
  })

  it('a verbatim re-delivery of the identical event emits nothing the second time', () => {
    const read = createFinalResultReader()
    const e = ev(0, [{ text: 'aphids on the kale', final: true }])
    expect(read(e)).toEqual(['aphids on the kale'])
    expect(read(e)).toEqual([])
  })

  it('multi-final utterance: several finals arriving in ONE event each emit once, in order', () => {
    const read = createFinalResultReader()
    expect(read(ev(0, [
      { text: 'checked the leeks', final: true },
      { text: 'they look leggy', final: true },
      { text: 'and the soil is dry', final: true },
    ]))).toEqual(['checked the leeks', 'they look leggy', 'and the soil is dry'])
    // The same list re-delivered (a later event that changed nothing we care about) adds nothing.
    expect(read(ev(0, [
      { text: 'checked the leeks', final: true },
      { text: 'they look leggy', final: true },
      { text: 'and the soil is dry', final: true },
    ]))).toEqual([])
  })

  it('a trailing interim does not block the final that follows it at the next index', () => {
    const read = createFinalResultReader()
    expect(read(ev(0, [
      { text: 'mulched bed three', final: true },
      { text: 'and', final: false },
    ]))).toEqual(['mulched bed three'])
    expect(read(ev(1, [
      { text: 'mulched bed three', final: true },
      { text: 'and staked the peas', final: true },
    ]))).toEqual(['and staked the peas'])
  })

  it('an interim never advances the high-water mark, so its final is still delivered', () => {
    const read = createFinalResultReader()
    expect(read(ev(0, [{ text: 'pruned', final: false }]))).toEqual([])
    expect(read(ev(0, [{ text: 'pruned the basil', final: true }]))).toEqual(['pruned the basil'])
  })

  it('two readers are independent — a new recognizer starts from a clean high-water mark', () => {
    const a = createFinalResultReader()
    const b = createFinalResultReader()
    expect(a(ev(0, [{ text: 'one', final: true }]))).toEqual(['one'])
    expect(b(ev(0, [{ text: 'one', final: true }]))).toEqual(['one'])
    expect(a(ev(0, [{ text: 'one', final: true }]))).toEqual([])
  })

  it('real repetition the user actually said is PRESERVED (it lands on distinct indices)', () => {
    // The dedupe must not "fix" duplication by deleting words. Saying a word twice for real
    // produces two results at two indices, and both must survive.
    const read = createFinalResultReader()
    expect(read(ev(0, [{ text: 'ripe', final: true }]))).toEqual(['ripe'])
    expect(read(ev(1, [
      { text: 'ripe', final: true },
      { text: 'ripe', final: true },
    ]))).toEqual(['ripe'])
  })

  it('tolerates a malformed event (no results, empty alternatives) without throwing', () => {
    const read = createFinalResultReader()
    expect(read({})).toEqual([])
    expect(read({ resultIndex: 0, results: [] })).toEqual([])
    expect(read(undefined)).toEqual([])
    const holed = { resultIndex: 0, results: Object.assign([null], { length: 1 }) }
    expect(read(holed)).toEqual([])
  })

  it('drops whitespace-only finals but still consumes the index', () => {
    const read = createFinalResultReader()
    expect(read(ev(0, [{ text: '   ', final: true }]))).toEqual([])
    expect(read(ev(1, [
      { text: '   ', final: true },
      { text: 'beans up', final: true },
    ]))).toEqual(['beans up'])
  })
})
