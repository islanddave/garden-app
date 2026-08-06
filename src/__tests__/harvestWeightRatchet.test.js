// V4-HARVRATCHET-001 — static guards on the ratchet job.
//
// The script's behaviour needs a live Neon and cannot run in vitest, so what is falsifiable here is
// its SHAPE — and every assertion below corresponds to a way a blind re-run of 0c would have caused
// real harm. This is the same static-guard idiom the lambda tests use (batch-order.test.js,
// harvest-weight-preserve.test.js): pin the properties whose absence is a silent disaster.
import fs from 'node:fs'
import path from 'node:path'
import { describe, it, expect } from 'vitest'

const ROOT = path.resolve(__dirname, '../..')
const SH = fs.readFileSync(path.join(ROOT, 'scripts/harvest-weight-ratchet.sh'), 'utf8')
const ACK = JSON.parse(fs.readFileSync(path.join(ROOT, 'scripts/harvest-weight-ratchet-ack.json'), 'utf8'))
const WF = fs.readFileSync(path.join(ROOT, '.github/workflows/harvest-weight-ratchet.yml'), 'utf8')

describe('the ratchet never destroys a real measurement', () => {
  // The one unrecoverable outcome. A weight Dave typed is an independent fact; re-deriving it would
  // replace it with an estimate and there is no way back. Copied verbatim from 0c-backfill-basis.
  it('carries 0c\'s measured-safe predicate, in both the analysis and the apply', () => {
    const pred = /NOT \(h\.weight_estimated IS FALSE AND h\.unit NOT IN \('g','kg','lb','oz'\)\)/g
    expect(SH.match(pred)?.length).toBe(2)
  })

  it('never reimplements the derivation — it calls resolve_harvest_weight', () => {
    expect(SH).toMatch(/public\.resolve_harvest_weight/)
    // A local COALESCE ladder is how v1 of this backfill drifted from the live write path.
    expect(SH).not.toMatch(/COALESCE\(\s*pv\.unit_weights.*ct\.unit_weights.*measured/is)
  })
})

describe('it is fail-closed, not fail-open', () => {
  it('dry-run is the default; --apply is required to write', () => {
    expect(SH).toMatch(/^APPLY=0$/m)
    expect(SH).toMatch(/--apply\)\s*APPLY=1/)
    // The write must be unreachable without the flag.
    expect(SH).toMatch(/\[ "\$APPLY" -eq 0 \][\s\S]{0,120}exit 0/)
  })

  it('an unreviewed outlier BLOCKS and exits 1 without writing', () => {
    expect(SH).toMatch(/N_OUT.*-gt 0/)
    expect(SH).toMatch(/BLOCK=1/)
    expect(SH).toMatch(/BLOCKED — nothing written[\s\S]{0,40}exit 1/)
  })

  it('an oversized one-step total move BLOCKS — the reward-inversion guard', () => {
    expect(SH).toMatch(/MAX_TOTAL_DROP_PCT/)
    expect(SH).toMatch(/reward-inversion/i)
  })

  // The outlier scan must look at the factors the resolver ACTUALLY uses. Scanning every derived
  // row would bury the two that matter under single-sample provisionals the resolver already
  // refuses; scanning none would let a 0.12x factor propagate silently.
  it('scopes the outlier scan to promoted factors, matching the resolver\'s own gate', () => {
    expect(SH).toMatch(/confidence IN \('high','medium'\) OR d\.sample_n >= 5/)
  })
})

describe('the ack file starts empty, and says why', () => {
  it('no cultivar is pre-accepted — every outlier blocks until reviewed', () => {
    expect(Array.isArray(ACK.reviewed_cultivar_ids)).toBe(true)
    expect(ACK.reviewed_cultivar_ids).toHaveLength(0)
  })

  it('points at void-don\'t-edit as the correction path rather than editing samples', () => {
    expect(ACK._comment).toMatch(/cultivar_weight_void/)
  })
})

describe('the workflow does not write on a schedule', () => {
  // The first application moves ~146 of 367 stored rows — a visible change to numbers Dave reads.
  // That should be a decision he makes once, not something that happens to him on a Monday.
  it('scheduled runs report; applying requires an explicit dispatch input', () => {
    expect(WF).toMatch(/schedule:/)
    expect(WF).toMatch(/inputs\.apply/)
    expect(WF).toMatch(/default:\s*false/)
  })

  it('runs after integrity-weekly so the two findings streams do not collide', () => {
    const cron = WF.match(/cron:\s*'([^']+)'/)[1]
    const [min, hour, , , dow] = cron.split(/\s+/)
    expect(dow).toBe('1')                 // Monday, same as integrity-weekly
    expect(Number(hour)).toBeGreaterThan(10)  // integrity-weekly is 10:00 UTC
    expect(min).toBe('0')
  })
})
