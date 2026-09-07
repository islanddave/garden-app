// src/__tests__/kitchenCueParity.test.js
// V5-BATCHCLOSEOUT-001 — the cue seam, bound from BOTH sides in one file.
//
// WHY THIS FILE EXISTS, and why neither build lane could write it.
// The close-out cue ("how did you know it was done?") crosses two lanes that built in parallel:
// the client puts `cue_observed` on the CLOSE body (lane L3), and the server writes the `finished`
// stage row from that key inside the close statement (lane L1). Each lane tested its own half and
// each half was green — and for one iteration the two halves DISAGREED: L3 had built a separate
// `POST /:id/stages` call, which against L1's server would have written TWO `finished` rows for one
// act. Both suites stayed green throughout, because neither could see the other side.
//
// That is the defect family this whole build kept finding: an assertion sitting one layer below the
// break. A wire shape asserted from one end is a hypothesis about the other end, never a fact about
// it. So this file reads BOTH SOURCES and asserts they name the same key for the same purpose.
//
// It is a SOURCE-TEXT parity test, deliberately, for the same reason `startChipParity.test.js` is:
// the two sides live in different runtimes (a React component and a Lambda handler that cannot be
// imported by vitest), so there is no single process in which both can be executed against each
// other. Text is the only shared surface. Every assertion therefore carries a GREEN CONTROL proving
// the regex matches something real — an absence assertion over source text goes vacuous the instant
// a rename makes the pattern match nothing, and this repo has shipped that bug.
//
// Lane: `npm test` (blocking). No database, no network, no render.
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const read = (p) => readFileSync(resolve(process.cwd(), p), 'utf8')

const CLIENT = read('src/components/putup/batchClose.js')
const SERVER = read('lambda/preservation/kitchenRoutes.js')
const VALIDATOR = read('lambda/preservation/kitchenBatch.js')

// The one string this file is about. Written once so a rename has exactly one place to fail.
const KEY = 'cue_observed'

describe('kitchen close cue — the client key and the server writer are the same key', () => {
  it('the sources this test reads are real and non-empty', () => {
    // The control for every read below. A path typo would otherwise make every assertion in this
    // file pass against an empty string.
    expect(CLIENT.length).toBeGreaterThan(500)
    expect(SERVER.length).toBeGreaterThan(500)
    expect(VALIDATOR.length).toBeGreaterThan(500)
    expect(CLIENT).toContain('closePatch')
    expect(SERVER).toContain('closeBatch')
  })

  it('the CLIENT puts the cue on the close body under that exact key', () => {
    // Full literal including the assignment, not a bare substring: `cue_observed` also appears in
    // this file's own prose and in the server's SELECT projection, so a bare `toContain(KEY)` would
    // pass on a comment.
    expect(CLIENT).toMatch(new RegExp(`body\\.${KEY}\\s*=`))
  })

  it('the SERVER reads that same key off the close body', () => {
    expect(SERVER).toMatch(new RegExp(`body\\.${KEY}`))
  })

  it('the server writes the cue into a `finished` stage row, gated on the close having happened', () => {
    // The three facts that make the cue a record of THIS close rather than a free-floating row:
    // it inserts into kitchen_stage_log, it stamps 'finished', and it selects from the `closed`
    // CTE — so a close that changed nothing writes no stage row.
    const closeStmt = SERVER.slice(SERVER.indexOf('async function closeBatch'))
    expect(closeStmt).toContain('INSERT INTO kitchen_stage_log')
    expect(closeStmt).toContain(`'finished'::text`)
    expect(closeStmt).toMatch(new RegExp(`${KEY}`))
    expect(closeStmt).toMatch(/FROM\s+closed\b/)
  })

  it('the validator lets the cue through rather than dropping it behind a 200', () => {
    // validateClose has no unknown-key rejection, so an unnamed key would be silently discarded and
    // the route would still answer 200 — the exact "writer with no write" shape found twice today.
    // The comment naming it is the durable record that the omission is deliberate.
    expect(VALIDATOR).toMatch(new RegExp(`${KEY}[\\s\\S]{0,200}(rides|body)`, 'i'))
  })

  it('the CLIENT does not also post a stage row for the cue — one act, one write', () => {
    // THE REGRESSION THIS FILE WAS BORN FROM. L3 originally posted `/stages` and then `/close`;
    // against L1's server that writes two `finished` rows for one close.
    // Absence assertion + green control on the same source, so it cannot pass by matching nothing.
    expect(CLIENT).toContain('/close')                    // control: the close path IS here
    expect(CLIENT).not.toMatch(/\/stages/)                // and the stage path is NOT
  })

  it('the cue is never validated, scored, compared or thresholded anywhere on the client', () => {
    // FOODSAFETY-RULING-V101: the app records a cue; it never assesses one. A cue that reached a
    // comparison would be the app deciding whether a batch was done, which is the determination
    // V101 says it cannot make.
    const cueLines = CLIENT.split('\n').filter(l => l.includes(KEY) && !l.trimStart().startsWith('//'))
    expect(cueLines.length).toBeGreaterThan(0)            // control: there ARE code lines to check
    for (const line of cueLines) {
      expect(line).not.toMatch(/[<>]=?|includes\(|test\(|match\(/)
    }
  })
})
