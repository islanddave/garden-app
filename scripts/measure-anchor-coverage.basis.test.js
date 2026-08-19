// OPS-ANCHORMEASUREBASIS-001 — measure-anchor-coverage.mjs must warn, in its own output, that the
// basis it reports for configs C/D is a harness artefact.
//
// THE HAZARD. asCalendarFallback stamps `dtm_basis: 'from-transplant'` onto every derived row so the
// derived tier can be priced without flipping DERIVED_ANCHOR_ENABLED. The queue COUNTS are real —
// same arithmetic the derived branch performs — but any statement about anchor BASIS taken from that
// table describes the harness, not the tier. The mechanism was always documented at the call site;
// what was missing was a warning legible to someone who did not already know it, which is exactly
// who runs a measurement script.
//
// THE INVARIANT IS CONDITIONAL, ON PURPOSE: `rewrites basis => warns`. A future change that stops
// rewriting dtm_basis (flipping the flag for real, say) removes the hazard, and at that point the
// banner is stale copy rather than a fix — so the guard should stop demanding it, not force it to be
// carried forever. The antecedent is asserted separately below so the conditional cannot quietly go
// vacuous: if the rewrite disappears, that assertion reds and a human reads this comment.
//
// The stdout check runs the REAL script as a subprocess over stdin, because the banner's whole
// purpose is to appear in a run's output — asserting the console.log exists in the source would pass
// on a banner that is unreachable behind a branch.
import { describe, it, expect } from 'vitest'
import { spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const ROOT = process.cwd()
const SCRIPT = join(ROOT, 'scripts', 'measure-anchor-coverage.mjs')
const SRC = readFileSync(SCRIPT, 'utf8')

// The script needs no DB: it reads its payload from stdin. An empty row set exercises every
// console.log on the path, including the whole config table, in ~200ms.
const PAYLOAD = JSON.stringify({
  et_today: '2026-08-19',
  rows: [],
  offset_samples: [],
  nursery_sample_n: 0,
  nursery_median_gap: 31,
})

function run() {
  const r = spawnSync(process.execPath, [SCRIPT], { input: PAYLOAD, encoding: 'utf8' })
  expect(r.status, `script exited ${r.status}\n${r.stderr}`).toBe(0)
  return r.stdout
}

describe('OPS-ANCHORMEASUREBASIS-001 — the instrument declares its own hazard', () => {
  it('still rewrites dtm_basis on derived rows — the antecedent of the guard below', () => {
    // Positive control on the conditional. Without it, deleting asCalendarFallback's rewrite would
    // make the banner assertion pass by irrelevance rather than by compliance.
    expect(SRC).toMatch(/dtm_basis:\s*'from-transplant'/)
  })

  it('prints the basis-hazard warning in the run output', () => {
    const out = run()
    expect(out).toMatch(/BASIS HAZARD \(OPS-ANCHORMEASUREBASIS-001\)/)
    expect(out).toMatch(/dtm_basis=from-transplant/)
    expect(out).toMatch(/do NOT quote anchor BASIS from this run/)
  })

  it('places the warning above the config table it applies to, not after it', () => {
    // Ordering is the point: a hazard note printed below the numbers is read after they have already
    // been copied. This also proves the banner is on the live path rather than in dead code.
    const out = run()
    const warn = out.indexOf('BASIS HAZARD')
    const header = out.indexOf('config                        total')
    const rowC = out.indexOf('C  + derived anchors')
    expect(warn, 'warning missing from stdout').toBeGreaterThan(-1)
    expect(rowC, 'config table missing from stdout — the run did not reach part 2').toBeGreaterThan(-1)
    expect(warn).toBeLessThan(header)
    expect(header).toBeLessThan(rowC)
  })
})
