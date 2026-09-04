// V5-KBCLOSE-001 — the pure half of the batch close-out: vocabulary, wire bodies, jar eligibility.
//
// ⚠ THE LINE EVERY ASSERTION IN THIS FILE SITS ON (FOODSAFETY-RULING-V101):
//   The app RECORDS a close. It never scores it, colours it, gates it, compares it, or asserts that
//   the batch completed. "Went to plan" was rejected as a verdict the app cannot make.
//
// TEST-SHAPE RULES, inherited from PutUpGoingNow.test.jsx / PutUpPhReading.test.jsx:
//   • FULL LITERALS. `toContain` on a fragment passes on a value ten days wrong; this repo shipped
//     exactly that assertion once.
//   • EVERY "must be absent" ASSERTION PAIRED WITH A GREEN CONTROL over the SAME call. An absence
//     proven over the wrong object, or over an empty string, passes for the wrong reason.
//   • PARITY IS TEXT-READ FROM THE SOURCE OF TRUTH, never re-typed. Three copies of one vocabulary
//     with no binding between them is how the START_CHIPS tables drifted by a day.
//
// CI LANE: `npm test` (vitest run --coverage) plus the blocking TZ=America/New_York re-run. Nothing
// here reads a clock or a locale, so the TZ lane is a no-op over this file BY CONSTRUCTION — which
// is itself asserted (describeOutcome returns a label and never a date).
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  CLOSE_OUTCOMES, OUTCOME_SLUGS, OUTCOME_FALLBACK_LABEL, CLOSE_ACTION_LABEL, KEPT_QUESTION,
  CUE_QUESTION,
  outcomeLabel, outcomesForKept, outcomeKeepsSomething, cuePlaceholder,
  closePatch, jarIsLinkable, jarBlockReason, describeOutcome,
} from '../components/putup/batchClose.js'

const __dirname = dirname(fileURLToPath(import.meta.url))
const REPO = resolve(__dirname, '../..')
const read = (rel) => readFileSync(resolve(REPO, rel), 'utf8')

const DDL = 'migrations/v5-inflightbatch-001/0a-additive-ddl.sql'
const KB = 'lambda/preservation/kitchenBatch.js'

// Pulls the quoted members out of a SQL ARRAY[...] or a JS array literal. Used for parity only —
// never to BUILD the client table, which would make the parity assertion self-satisfying.
const quoted = (s) => [...s.matchAll(/'([a-z_]+)'/g)].map(m => m[1])

const UUID_A = '11111111-1111-4111-8111-111111111111'
const UUID_B = '22222222-2222-4222-8222-222222222222'

const JAR_CLEAN = { id: 'jar-clean', harvest_log_id: null, batch_id: null }
const JAR_HARVEST_LINKED = { id: 'jar-h', harvest_log_id: 'hl-1', batch_id: null }
const JAR_OTHER_BATCH = { id: 'jar-b', harvest_log_id: null, batch_id: 'kb-other' }
const JAR_THIS_BATCH = { id: 'jar-t', harvest_log_id: null, batch_id: 'kb-mine' }
// The wire as it is TODAY: projectRow does not expose batch_id until BUG-JARSTEAL-001 lands, so the
// key is absent rather than null. A fixture that invented the key would test a wire that does not
// exist yet.
const JAR_PRE_JARSTEAL_FIX = { id: 'jar-old', harvest_log_id: null }

describe('the six outcomes — one vocabulary, three copies, bound', () => {
  it('is the DDL set, in the DDL order, and the client never re-types it', () => {
    const ddlBlock = /chk_kitchen_batch_outcome[\s\S]*?ARRAY\[([\s\S]*?)\]/.exec(read(DDL))
    expect(ddlBlock).not.toBeNull()
    const fromDdl = quoted(ddlBlock[1])
    const kbBlock = /export const KITCHEN_OUTCOMES = \[([\s\S]*?)\]/.exec(read(KB))
    expect(kbBlock).not.toBeNull()
    const fromLambda = quoted(kbBlock[1])

    // The green control on the two text reads: a moved file or a changed literal would otherwise
    // leave both arrays empty and every comparison below true.
    expect(fromDdl).toEqual(['put_up', 'put_up_different', 'consumed', 'given_away', 'discarded_spoiled', 'abandoned'])
    expect(fromLambda).toEqual(fromDdl)
    expect(CLOSE_OUTCOMES.map(o => o.value)).toEqual(fromDdl)
  })

  it('carries the FINAL labels, in full, and none of them is a verdict about the food', () => {
    expect(CLOSE_OUTCOMES.map(o => o.label)).toEqual([
      'Put it up',
      'Put it up — but not what I set out to make',
      'Ate it',
      'Gave it away',
      'It spoiled — threw it out',
      'Gave up on it',
    ])
    // The struck clause, and its green control: the label it was struck FROM is still here.
    expect(CLOSE_OUTCOMES.map(o => o.label).join('|')).not.toMatch(/went to plan/i)
    expect(CLOSE_OUTCOMES.map(o => o.label).join('|')).toContain('Put it up')
  })

  it('is frozen, so a consumer cannot quietly extend the vocabulary in place', () => {
    expect(Object.isFrozen(CLOSE_OUTCOMES)).toBe(true)
    expect(Object.isFrozen(CLOSE_OUTCOMES[0])).toBe(true)
    expect(Object.isFrozen(OUTCOME_SLUGS)).toBe(true)
  })

  it('maps every value to a label, and the fallback is NOT the raw value', () => {
    for (const o of CLOSE_OUTCOMES) {
      expect(outcomeLabel(o.value)).toBe(o.label)
      expect(outcomeLabel(o.value)).not.toBe(o.value)
    }
    // A value this bundle has never seen — a server that learned a seventh outcome after the client
    // shipped. Echoing it would put a machine value in the DOM.
    expect(outcomeLabel('became_a_second_batch')).toBe(OUTCOME_FALLBACK_LABEL)
    expect(outcomeLabel('became_a_second_batch')).not.toBe('became_a_second_batch')
    expect(outcomeLabel(null)).toBe(OUTCOME_FALLBACK_LABEL)
    expect(OUTCOME_FALLBACK_LABEL).toBe('Closed')
  })

  it('gives every value a testid segment that does not leak the enum or the word the sweep hunts', () => {
    const slugs = CLOSE_OUTCOMES.map(o => OUTCOME_SLUGS[o.value])
    expect(slugs).toEqual(['kept', 'kept-different', 'ate', 'gave', 'binned', 'gaveup'])
    expect(new Set(slugs).size).toBe(6)
    for (const o of CLOSE_OUTCOMES) {
      expect(OUTCOME_SLUGS[o.value]).not.toContain(o.value)
      expect(OUTCOME_SLUGS[o.value]).not.toMatch(/spoil/i)
    }
    // Green control for the two absence arms above: the raw value DOES contain the thing they
    // assert the slug does not, so the arms are looking at a real difference.
    expect('discarded_spoiled').toMatch(/spoil/i)
  })
})

describe('the two-step split', () => {
  it('partitions the six on "did it make anything you kept?" and nothing is lost or doubled', () => {
    const yes = outcomesForKept(true).map(o => o.value)
    const no = outcomesForKept(false).map(o => o.value)
    expect(yes).toEqual(['put_up', 'put_up_different'])
    expect(no).toEqual(['consumed', 'given_away', 'discarded_spoiled', 'abandoned'])
    expect([...yes, ...no].sort()).toEqual(CLOSE_OUTCOMES.map(o => o.value).sort())
    expect(yes.filter(v => no.includes(v))).toEqual([])
  })

  it('answers the same question one value at a time', () => {
    expect(outcomeKeepsSomething('put_up')).toBe(true)
    expect(outcomeKeepsSomething('put_up_different')).toBe(true)
    expect(outcomeKeepsSomething('abandoned')).toBe(false)
    expect(outcomeKeepsSomething('nonsense')).toBe(false)
  })

  it('asks questions, never issues an imperative, and never spends the word "Finish"', () => {
    expect(CLOSE_ACTION_LABEL).toBe('What happened to it?')
    expect(KEPT_QUESTION).toBe('Did it make anything you kept?')
    expect(CUE_QUESTION).toBe('How did you know it was done?')
    // `finished` is a live, re-enterable stage_kind — three of six documented candy recoveries
    // re-enter after it — so the irreversible act must not wear its name.
    expect(CLOSE_ACTION_LABEL).not.toMatch(/finish/i)
  })
})

describe('the cue — a record, never an assessment', () => {
  it('offers a placeholder for every kind the schema allows, and a neutral one for a kind-less batch', () => {
    const kinds = quoted(/export const KITCHEN_BATCH_KINDS = \[([\s\S]*?)\]/.exec(read(KB))[1])
    expect(kinds).toEqual(['ferment', 'dehydrate', 'candy', 'cure', 'infuse', 'age', 'other'])
    for (const k of kinds) expect(typeof cuePlaceholder(k)).toBe('string')
    expect(cuePlaceholder('ferment')).toBe('bubbling stopped')
    expect(cuePlaceholder('dehydrate')).toBe('snapped clean')
    // `kind` is nullable on purpose, and a kind-less batch is the commonest live shape.
    expect(cuePlaceholder(null)).toBe('what made you call it?')
    expect(cuePlaceholder('a_kind_from_the_future')).toBe('what made you call it?')
  })

  it('is no longer a client-written stage row — that constant and its builder are gone', async () => {
    // The server writes the `finished` row from cue_observed inside the close statement. A leftover
    // client-side stage builder would be a second writer for one act, so its ABSENCE is the contract.
    const mod = await import('../components/putup/batchClose.js')
    expect(mod.cueStagePatch).toBeUndefined()
    expect(mod.CUE_STAGE_KIND).toBeUndefined()
    // GREEN CONTROL: the module DID load and its other exports are here, so the two absences above
    // are about those names and not about a failed import resolving to an empty object.
    expect(typeof mod.closePatch).toBe('function')
    expect(mod.CUE_QUESTION).toBe('How did you know it was done?')
  })
})

describe('closePatch — the body POST /:id/close actually accepts', () => {
  it('sends the outcome alone when that is all there is', () => {
    expect(closePatch({ outcome: 'abandoned' })).toEqual({ outcome: 'abandoned' })
  })

  it('trims the note, and a whitespace-only note is NOT a note', () => {
    expect(closePatch({ outcome: 'put_up', note: '  peppers were soft  ' }))
      .toEqual({ outcome: 'put_up', outcome_note: 'peppers were soft' })
    expect(closePatch({ outcome: 'put_up', note: '   ' })).toEqual({ outcome: 'put_up' })
  })

  it('carries the cue on this body — the server writes the finished stage row from it', () => {
    const body = closePatch({ outcome: 'put_up', note: 'kept two pints', cue: '  snapped clean  ' })
    expect(body).toEqual({
      outcome: 'put_up', outcome_note: 'kept two pints', cue_observed: 'snapped clean',
    })
    expect(Object.keys(body).sort()).toEqual(['cue_observed', 'outcome', 'outcome_note'])
  })

  it('omits the cue key when nothing was typed — absent, never an empty string', () => {
    expect(closePatch({ outcome: 'put_up', cue: '   ' })).toEqual({ outcome: 'put_up' })
    expect(closePatch({ outcome: 'put_up', cue: '' })).toEqual({ outcome: 'put_up' })
    expect(closePatch({ outcome: 'put_up', cue: null })).toEqual({ outcome: 'put_up' })
    // GREEN CONTROL over the same builder: a cue that WAS typed does reach the body, so the four
    // omissions above are about emptiness and not about the key never being written at all.
    expect(closePatch({ outcome: 'put_up', cue: 'snapped clean' }))
      .toEqual({ outcome: 'put_up', cue_observed: 'snapped clean' })
  })

  it('de-duplicates jar ids and omits the key entirely when nothing was picked', () => {
    expect(closePatch({ outcome: 'put_up', outputIds: [UUID_A, UUID_B, UUID_A] }))
      .toEqual({ outcome: 'put_up', output_preservation_log_ids: [UUID_A, UUID_B] })
    expect(closePatch({ outcome: 'put_up', outputIds: [] })).toEqual({ outcome: 'put_up' })
    expect(closePatch({ outcome: 'put_up', outputIds: null })).toEqual({ outcome: 'put_up' })
  })

  it('refuses a body that could never commit, rather than sending it and reading an opaque 400', () => {
    expect(closePatch({ outcome: 'not_an_outcome' })).toBeNull()
    expect(closePatch({ outcome: null })).toBeNull()
    expect(closePatch({})).toBeNull()
    expect(closePatch()).toBeNull()
    expect(closePatch({ outcome: 'put_up', outputIds: 'jar-1' })).toBeNull()
    expect(closePatch({ outcome: 'put_up', outputIds: [UUID_A, 'jar-1'] })).toBeNull()
    expect(closePatch({ outcome: 'put_up', cue: 42 })).toBeNull()
    // Green control: the same shape WITH a valid outcome and a valid id list does commit, so the
    // refusals above are about the invalid input rather than about the builder being broken.
    expect(closePatch({ outcome: 'put_up', outputIds: [UUID_A] }))
      .toEqual({ outcome: 'put_up', output_preservation_log_ids: [UUID_A] })
  })
})

describe('jar eligibility — offered and disabled, never omitted', () => {
  it('links only a jar with no provenance of its own', () => {
    expect(jarIsLinkable(JAR_CLEAN)).toBe(true)
    expect(jarIsLinkable(JAR_HARVEST_LINKED)).toBe(false)
    expect(jarIsLinkable(JAR_OTHER_BATCH)).toBe(false)
    expect(jarIsLinkable(null)).toBe(false)
  })

  it('states WHY, and distinguishes this batch from another one', () => {
    expect(jarBlockReason(JAR_CLEAN, 'kb-mine')).toBeNull()
    expect(jarBlockReason(JAR_HARVEST_LINKED, 'kb-mine')).toBe('already linked to one harvest')
    expect(jarBlockReason(JAR_OTHER_BATCH, 'kb-mine')).toBe('already linked to another batch')
    expect(jarBlockReason(JAR_THIS_BATCH, 'kb-mine')).toBe('already linked to this batch')
    expect(jarBlockReason(JAR_THIS_BATCH)).toBe('already linked to another batch')
    expect(jarBlockReason(null)).toBeNull()
  })

  it('degrades to the shipped behaviour on the pre-BUG-JARSTEAL-001 wire, never to a wrong refusal', () => {
    // projectRow does not expose batch_id yet, so the key is ABSENT. Absent must read as "not
    // linked" — the gate is L1's server-side conjunct, and a client that refused every jar because
    // it could not see the column would break the flow it is meant to protect.
    expect(jarIsLinkable(JAR_PRE_JARSTEAL_FIX)).toBe(true)
    expect(jarBlockReason(JAR_PRE_JARSTEAL_FIX, 'kb-mine')).toBeNull()
    // Green control: the same row WITH the column present is refused, so the pass above is about the
    // column being absent and not about the predicate never refusing anything.
    expect(jarIsLinkable({ ...JAR_PRE_JARSTEAL_FIX, batch_id: 'kb-other' })).toBe(false)
  })
})

describe('describeOutcome — reading a closed batch back', () => {
  it('says nothing about a batch that is still going', () => {
    expect(describeOutcome({ id: 'kb-1', closed_at: null, outcome: null })).toBeNull()
    expect(describeOutcome(null)).toBeNull()
  })

  it('renders the label and never the stored value', () => {
    expect(describeOutcome({ closed_at: '2026-09-04T12:00:00.000Z', outcome: 'discarded_spoiled' }))
      .toBe('It spoiled — threw it out')
    expect(describeOutcome({ closed_at: '2026-09-04T12:00:00.000Z', outcome: 'discarded_spoiled' }))
      .not.toBe('discarded_spoiled')
    expect(describeOutcome({ closed_at: '2026-09-04T12:00:00.000Z', outcome: 'put_up' })).toBe('Put it up')
  })

  it('falls back without echoing a value it does not know', () => {
    const out = describeOutcome({ closed_at: '2026-09-04T12:00:00.000Z', outcome: 'became_a_second_batch' })
    expect(out).toBe('Closed')
    expect(out).not.toBe('became_a_second_batch')
  })

  it('is a label and never a date, so the TZ re-run has nothing to bite on here', () => {
    const withZ = describeOutcome({ closed_at: '2026-09-04T12:00:00.000Z', outcome: 'put_up' })
    const withOffset = describeOutcome({ closed_at: '2026-09-04T23:59:00.000Z', outcome: 'put_up' })
    expect(withZ).toBe('Put it up')
    expect(withOffset).toBe(withZ)
  })
})

// The same source-level guard PutUpPhReading.test.jsx runs over its lane, extended to this one. It
// exists because a NUMBER on this surface would be a threshold whether or not any code compares to
// it — and because the whole lane's copy is new, so nothing else sweeps it.
const LANE_SOURCES = [
  ['src/components/putup/batchClose.js', 'CLOSE_OUTCOMES'],
  ['src/components/putup/BatchCloseField.jsx', 'batch-close-sheet'],
  ['src/components/putup/BatchDetailView.jsx', 'batch-detail-view'],
  ['src/components/putup/JarPicker.jsx', 'jar-picker'],
]
const ACID_LINE_NUMBERS = ['4.60', '4.6', '4.4', '4.2', '4.1', '4.0', '3.8', '3.3', '5.0']
const acidRe = (n) => new RegExp(`(?<![\\d.])${n.replace('.', '\\.')}(?!\\d)(?!\\.\\d)`)

describe('the acid line, and every safety verdict, appear nowhere in this lane\'s source', () => {
  it.each(LANE_SOURCES)('%s', (rel, sentinel) => {
    const src = read(rel)
    // GREEN CONTROL: a typo'd path or a moved file would make every arm below pass over nothing.
    expect(src).toContain(sentinel)
    for (const n of ACID_LINE_NUMBERS) {
      expect(`${rel} contains ${n}: ${acidRe(n).test(src)}`).toBe(`${rel} contains ${n}: false`)
    }
    // No threshold vocabulary in the source either — a constant named for a safety line is the shape
    // this class of defect actually takes.
    expect(src).not.toMatch(/SAFE_PH|PH_THRESHOLD|SHELF_STABLE|IS_SAFE|ACID_FLOOR/)
  })
})
