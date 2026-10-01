// Put-Up UX pass R1, lane E (D12) — the completion stub's words (putItUp.js completionStub): rows that read
// the same are said ONCE with their counts added, and a row is named only when its name is not the
// batch's. The pinned literal for the two-row case is amended where it lives (putItUp.test.js); this file
// holds the rest of the rule and the banned-word sweep the stub's words did not have.
// Instants are local-time literals. CI LANE: `npm test` plus the blocking TZ re-run.
import { describe, it, expect } from 'vitest'
import { completionStub, newRow, CONTAINER_PRESETS } from '../components/putup/putItUp.js'

const NOW = new Date(2026, 8, 29, 15, 0)   // Tue Sep 29 2026, 3 pm local
const BANNED = /\bsafe\b|shelf.life|shelf.stable|\bkeeps\b|\bgood\b|\bready\b|\bdone\b|\bexpired\b|\btable\b|\bdefault\b|\bbasis\b/i
const BATCH = { label: 'Megatron mash' }
const fridge = { key: 'id:p1', id: 'p1', label: 'Fridge', kind: 'fridge' }
const chest = { key: 'id:p2', id: 'p2', label: 'Chest Freezer 1', kind: 'deep_freezer' }
const woozy5 = CONTAINER_PRESETS.find(c => c.label === '5 oz woozy')
const woozy8 = CONTAINER_PRESETS.find(c => c.label === '8 oz woozy')
const row = (patch) => ({ ...newRow(), ...patch })
const stub = (rows, jars = []) => completionStub({ batch: BATCH, rows, jars, now: NOW })

describe('the completion stub — identical rows read as one', () => {
  // MUTATION: one part per row -> "4 × 5 oz woozy · Fridge · 1 × 5 oz woozy · Fridge".
  it('four woozies and one more, same size and place: "5 × 5 oz woozy · Fridge"', () => {
    const r1 = row({ count: '4', container: woozy5, place: fridge })
    expect(stub([r1, newRow(r1)])).toBe('Megatron mash — put up · 5 × 5 oz woozy · Fridge')
  })

  // MUTATION: merge on the container alone -> the freezer row is swallowed into "6 × 8 oz woozy · Fridge".
  it('a row at another place, or of another size, stays its own part, in the order first said', () => {
    const rows = [
      row({ count: '2', container: woozy8, place: fridge }),
      row({ count: '1', container: woozy8, place: chest }),
      row({ count: '3', container: woozy8, place: fridge }),
      row({ count: '2', container: woozy5, place: fridge }),
    ]
    expect(stub(rows)).toBe('Megatron mash — put up · 5 × 8 oz woozy · Fridge · 1 × 8 oz woozy · Chest Freezer 1 · 2 × 5 oz woozy · Fridge')
  })

  it('rows with no container add up as containers; a count mid-edit ("") counts as the 1 it sends', () => {
    expect(stub([row({ count: '2', place: fridge }), row({ count: '', place: fridge })])).toBe('Megatron mash — put up · 3 containers · Fridge')
    expect(stub([row({ place: fridge })])).toBe('Megatron mash — put up · 1 container · Fridge')
  })

  // What the stub does not say does not split a part: the two rows below differ only in pH, Raw and the
  // discard choice, and print the same words.
  it('rows that differ only in what the stub does not say still read as one', () => {
    const a = row({ count: '2', container: woozy8, place: fridge, ph: '3.7' })
    const b = row({ count: '1', container: woozy8, place: fridge, isRaw: true, discard: { mode: 'none', date: '' } })
    expect(stub([a, b])).toBe('Megatron mash — put up · 3 × 8 oz woozy · Fridge')
  })
})

describe('the completion stub — a row is named when its name is not the batch\'s', () => {
  // Appendix C's two rows. MUTATION: drop the name from the part -> the two read as one "4 × 8 oz woozy ·
  // Fridge" and nothing says there were two sauces.
  it('two named rows of one size and place stay two parts, each under its own name', () => {
    const r1 = row({ count: '2', container: woozy8, place: fridge, name: 'Megatron plain' })
    const r2 = { ...newRow(r1), count: '2', name: 'Megatron reaper' }
    const jars = [{ label: 'Megatron plain', preserved_at: '2026-10-08', preserved_at_precision: 'day', use_by_target: null, use_by_basis: 'none' }]
    expect(stub([r1, r2], jars)).toBe(
      "Megatron mash — put up · Megatron plain: 2 × 8 oz woozy · Fridge · Megatron reaper: 2 × 8 oz woozy · Fridge · Write 'Megatron plain · Oct 8' on the label")
  })

  // MUTATION: name a row whenever it has a name -> "Megatron mash: 1 × …" repeats the batch.
  it('a row named as the batch (or left blank, or padded) is not named, and merges with the unnamed rows', () => {
    const rows = [
      row({ count: '2', container: woozy8, place: fridge }),
      row({ count: '1', container: woozy8, place: fridge, name: 'Megatron mash' }),
      row({ count: '1', container: woozy8, place: fridge, name: '  Megatron mash  ' }),
      row({ count: '1', container: woozy8, place: fridge, name: '   ' }),
    ]
    expect(stub(rows)).toBe('Megatron mash — put up · 5 × 8 oz woozy · Fridge')
  })

  it('a named row and an unnamed one of the same size and place stay apart; two rows under one name merge', () => {
    const rows = [
      row({ count: '2', container: woozy8, place: fridge }),
      row({ count: '1', container: woozy8, place: fridge, name: 'Megatron reaper' }),
      row({ count: '2', container: woozy8, place: fridge, name: 'Megatron reaper ' }),
    ]
    expect(stub(rows)).toBe('Megatron mash — put up · 2 × 8 oz woozy · Fridge · Megatron reaper: 3 × 8 oz woozy · Fridge')
  })

  it('a batch with no label still reads, and names every named row', () => {
    expect(completionStub({ batch: { label: '' }, rows: [row({ place: fridge, name: 'Plain' })], jars: [], now: NOW }))
      .toBe('This batch — put up · Plain: 1 container · Fridge')
  })
})

describe('the completion stub — words', () => {
  it('no banned word in anything the stub says', () => {
    const r1 = row({ count: '2', container: woozy8, place: fridge, name: 'Megatron plain' })
    const jar = { label: 'Megatron plain', preserved_at: '2026-10-08', preserved_at_precision: 'month', use_by_target: '2026-12-08', use_by_basis: 'recipe' }
    const said = [
      stub([r1, { ...newRow(r1), count: '2', name: 'Megatron reaper' }], [jar]),
      stub([row({ place: chest })], [{ ...jar, use_by_basis: 'table', preserved_at_precision: 'day' }]),
      stub([row({ count: '3', place: fridge }), row({ count: '2', place: fridge })]),
    ]
    for (const s of said) expect(`${s}: ${BANNED.test(s)}`).toBe(`${s}: false`)
  })
})
