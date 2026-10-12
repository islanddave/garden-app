// BUG-NEWLOTNOIDEMPOTENCYKEY-001 — the key a NEW seed lot's create carries (seedLotKey.js), without a
// screen: which saves share a key, when a key is let go, and which save finishes a lot two of them
// were answered with.
import { describe, it, expect } from 'vitest'
import { sheetOpened, keyForDraft } from '../components/seed/seedLotKey.js'
import { REPLAY_FRESH_MS } from '../components/kitchen/idempotencyKey.js'

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/
// Each case names its own draft, so nothing one case keeps is another case's.
let n = 0
const draft = (extra = {}) => [JSON.stringify({ name: `lot ${++n}`, ...extra }), null, null]

describe('one key per draft', () => {
  it('the same draft saved twice from one sheet carries one key, a v4 uuid', () => {
    const sheet = sheetOpened()
    const sends = draft()
    const a = keyForDraft(sends, sheet)
    const b = keyForDraft(sends, sheet)
    expect(a.key).toMatch(UUID)
    expect(b.key).toBe(a.key)
  })

  it('the same draft from a sheet opened later carries the same key while nobody has seen it finish', () => {
    const sends = draft()
    const a = keyForDraft(sends, sheetOpened())
    const b = keyForDraft(sends, sheetOpened())
    expect(b.key).toBe(a.key)
  })

  it('anything the save would send differently is another draft: the lot, its measures, its process', () => {
    const sheet = sheetOpened()
    const lot = JSON.stringify({ name: `lot ${++n}` })
    const keys = [
      keyForDraft([lot, null, null], sheet).key,
      keyForDraft([JSON.stringify({ name: `lot ${++n}` }), null, null], sheet).key,
      keyForDraft([lot, { seed_count: 40, seed_count_estimated: false }, null], sheet).key,
      keyForDraft([lot, { seed_count: 41, seed_count_estimated: false }, null], sheet).key,
      keyForDraft([lot, null, 'wet'], sheet).key,
      keyForDraft([lot, null, 'dry'], sheet).key,
    ]
    expect(new Set(keys).size).toBe(keys.length)
    // And each of them is still its own draft's key when it is saved again.
    expect(keyForDraft([lot, null, 'wet'], sheet).key).toBe(keys[4])
  })
})

describe('when a key is let go', () => {
  it('an open sheet saw the save finish: the same draft afterwards is a new lot with a new key', () => {
    const sends = draft()
    const a = keyForDraft(sends, sheetOpened())
    expect(a.otherSaveOf('lot-1')).toBeNull()
    a.ended({ stageWritten: null }, true)
    expect(keyForDraft(sends, sheetOpened()).key).not.toBe(a.key)
  })

  it('a save nobody saw finish keeps its key until ten minutes after it last went out', () => {
    const sends = draft()
    const t0 = 1_000_000
    const a = keyForDraft(sends, sheetOpened(), t0)
    expect(keyForDraft(sends, sheetOpened(), t0 + REPLAY_FRESH_MS).key).toBe(a.key)
    // That second save went out at t0 + ten minutes, so the ten minutes are counted from there.
    expect(keyForDraft(sends, sheetOpened(), t0 + 2 * REPLAY_FRESH_MS).key).toBe(a.key)
    expect(keyForDraft(sends, sheetOpened(), t0 + 3 * REPLAY_FRESH_MS + 1).key).not.toBe(a.key)
  })

  it('a save that finished after its sheet was closed still answers to a sheet that was open again by then, and to no later one', () => {
    const sends = draft()
    const a = keyForDraft(sends, sheetOpened())
    const reopened = sheetOpened()
    expect(a.otherSaveOf('lot-1')).toBeNull()
    a.ended({ stageWritten: null }, false)
    const later = sheetOpened()
    expect(keyForDraft(sends, reopened).key).toBe(a.key)
    expect(keyForDraft(sends, later).key).not.toBe(a.key)
  })

  it('a refusal lets go of nothing: with no ending, the key stands', () => {
    const sends = draft()
    const sheet = sheetOpened()
    const a = keyForDraft(sends, sheet)
    // Nothing is told to the key about a save that made no lot.
    expect(keyForDraft(sends, sheet).key).toBe(a.key)
  })
})

describe('two saves of one draft answered with one lot', () => {
  it('the first to be answered finishes the lot; the other is handed its ending to wait for', async () => {
    const sends = draft()
    const a = keyForDraft(sends, sheetOpened())
    const b = keyForDraft(sends, sheetOpened())
    expect(a.otherSaveOf('lot-1')).toBeNull()
    const waiting = b.otherSaveOf('lot-1')
    expect(waiting).toBeInstanceOf(Promise)
    let heard = 'nothing yet'
    waiting.then((v) => { heard = v })
    await Promise.resolve()
    expect(heard).toBe('nothing yet')
    a.ended({ stageWritten: 'drying' }, false)
    expect(await waiting).toEqual({ stageWritten: 'drying' })
  })

  it('two different lots (a server that does not know the key) are each finished by their own save', () => {
    const sends = draft()
    const a = keyForDraft(sends, sheetOpened())
    const b = keyForDraft(sends, sheetOpened())
    expect(a.otherSaveOf('lot-1')).toBeNull()
    expect(b.otherSaveOf('lot-2')).toBeNull()
  })

  it('an answer that names no lot is nobody else\'s', () => {
    const sends = draft()
    const a = keyForDraft(sends, sheetOpened())
    const b = keyForDraft(sends, sheetOpened())
    expect(a.otherSaveOf(undefined)).toBeNull()
    expect(b.otherSaveOf(undefined)).toBeNull()
  })

  it('an ending is said once: a second call changes nothing, and a save that stopped short frees the one waiting', async () => {
    const sends = draft()
    const a = keyForDraft(sends, sheetOpened())
    const b = keyForDraft(sends, sheetOpened())
    a.otherSaveOf('lot-1')
    const waiting = b.otherSaveOf('lot-1')
    a.ended(null, false)
    a.ended({ stageWritten: 'drying' }, true)
    expect(await waiting).toBeNull()
    // The second call did not let go of the key either.
    expect(keyForDraft(sends, 0).key).toBe(a.key)
  })

  it('the save that waited ends in an open sheet: the key is let go', () => {
    const sends = draft()
    const a = keyForDraft(sends, sheetOpened())
    const reopened = sheetOpened()
    const b = keyForDraft(sends, reopened)
    a.otherSaveOf('lot-1')
    a.ended({ stageWritten: null }, false)
    expect(b.otherSaveOf('lot-1')).toBeInstanceOf(Promise)
    b.ended({ stageWritten: null }, true)
    expect(keyForDraft(sends, reopened).key).not.toBe(a.key)
  })
})
