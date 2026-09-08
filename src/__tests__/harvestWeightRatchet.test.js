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
const VERDICT = fs.readFileSync(path.join(ROOT, 'scripts/harvest_ratchet_verdict.py'), 'utf8')
const ACK = JSON.parse(fs.readFileSync(path.join(ROOT, 'scripts/harvest-weight-ratchet-ack.json'), 'utf8'))
const WF = fs.readFileSync(path.join(ROOT, '.github/workflows/harvest-weight-ratchet.yml'), 'utf8')

describe('the ratchet never destroys a real measurement', () => {
  // The one unrecoverable outcome. A weight Dave typed is an independent fact; re-deriving it would
  // replace it with an estimate and there is no way back. Copied verbatim from 0c-backfill-basis.
  // THREE places, and all three matter: the ANALYSIS (so the report describes the rows that will
  // actually move), the SNAPSHOT (so a restore can put back exactly the row set that was touched —
  // a snapshot narrower than the update is a restore that silently misses rows), and the APPLY.
  it('carries 0c\'s measured-safe predicate in the analysis, the snapshot AND the apply', () => {
    const pred = /NOT \(h\.weight_estimated IS FALSE AND h\.unit NOT IN \('g','kg','lb','oz'\)\)/g
    expect(SH.match(pred)?.length).toBe(3)
  })

  // The apply is a one-way door without this: resolve_harvest_weight is not invertible and
  // cultivar_weight_derived is a VIEW, so the inputs that produced an old value are not retained.
  it('snapshots before writing, in the same transaction', () => {
    expect(SH).toMatch(/CREATE TABLE :"snap" AS/)
    const applyBlock = SH.slice(SH.indexOf('SNAP='))
    expect(applyBlock.indexOf('CREATE TABLE')).toBeLessThan(applyBlock.indexOf('UPDATE public.harvest_log'))
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

  // Both blocking conditions moved into harvest_ratchet_verdict.py (OPS-RATCHETREPORTDARK-001) and
  // the shell now RELAYS the verdict instead of computing it. Both halves are pinned: a guard that
  // survives on only one side of the split is not a guard, and a re-point that drops the shell half
  // would leave the decision computed and then discarded.
  it('an unreviewed outlier BLOCKS and exits 1 without writing', () => {
    expect(VERDICT).toMatch(/if outliers:/)
    expect(VERDICT).toMatch(/return 1 if report\['status'\] == STATUS_ALERT else 0/)
    expect(SH).toMatch(/\|\| BLOCK=\$\?/)
    expect(SH).toMatch(/BLOCKED — nothing written[\s\S]{0,40}exit 1/)
  })

  it('an oversized one-step total move BLOCKS — the reward-inversion guard', () => {
    // The threshold is still the shell's to read and must still reach the verdict — an env var the
    // split quietly stopped forwarding is a limit that silently becomes the hardcoded default.
    expect(SH).toMatch(/^python3 "\$HERE\/harvest_ratchet_verdict\.py"[\s\S]{0,120}\$MAX_TOTAL_DROP_PCT/m)
    expect(VERDICT).toMatch(/reward-inversion/i)
    // Sign for sign, as the shell made it: a DROP deeper than the limit blocks; a rise never has.
    expect(VERDICT).toMatch(/drop < -float\(max_total_drop_pct\)/)
  })

  // The outlier scan must look at the factors the resolver ACTUALLY uses. Scanning every derived
  // row would bury the two that matter under single-sample provisionals the resolver already
  // refuses; scanning none would let a 0.12x factor propagate silently.
  //
  // The gate tracks resolver v5 (V4-CAL1INDEP-001): the accumulation hatch counts INDEPENDENT
  // observations, so N duplicate rows describing one weighing cannot promote. coalesce(...) keeps
  // the job runnable against a database on either side of that migration.
  it('scopes the outlier scan to promoted factors, matching the resolver\'s own gate', () => {
    expect(SH).toMatch(/confidence IN \('high','medium'\) OR coalesce\(i\.independent_n, d\.sample_n\) >= 5/)
  })

  // V4-CAL1INDEP-001. Independence is recomputed from the BASE tables rather than read off
  // cultivar_weight_derived.independent_n, because a missing column is a parse error rather than a
  // branchable condition and this job has to run on both sides of the migration.
  it('recomputes independence from base tables, not from the view column', () => {
    expect(SH).toMatch(/count\(DISTINCT \(l\.sampled_at, l\.ratio_key\)\)/)
    expect(SH).not.toMatch(/FROM cultivar_weight_derived[\s\S]{0,200}d\.independent_n/)
  })

  // A factor propagating on a single distinct ratio, and one weighing logged under two units, are
  // both reported. Advisory rather than blocking: neither can propagate a factor the outlier scan
  // has not already seen, so blocking on them would stall the job over a labelling concern.
  it('reports one-ratio factors and cross-unit duplicates without blocking on them', () => {
    expect(SH).toMatch(/degenerate_promoted/)   // the SQL that finds them is still the shell's
    expect(SH).toMatch(/crossunit_suspects/)
    expect(VERDICT).toMatch(/ONE-RATIO/)        // the lines that report them are the verdict's
    expect(VERDICT).toMatch(/CROSS-UNIT/)
    // The single line that decides blocking. Only alerts[] can reach ALERT, so an advisory finding
    // appended to the wrong list cannot start stalling the job over a labelling concern.
    expect(VERDICT).toMatch(
      /report\['status'\] = STATUS_ALERT if alerts else \(STATUS_WARN if warnings else STATUS_OK\)/
    )
  })
})

describe('the report survives enforcement (OPS-RATCHETREPORTDARK-001)', () => {
  // Three scheduled runs — 2026-08-24, 08-31, 09-07 — blocked correctly, uploaded a complete
  // artifact, and read as three weeks of silence: the verdict existed only as the exit code, which
  // cannot tell "a factor needs your judgement" apart from "the job is broken". What the verdict
  // SAYS is tested in scripts/test_harvest_ratchet_verdict.py; what is only checkable here is the
  // wiring that has to hold for it to be said at all.

  // Anchored at line start, here and below. The script NAMES the verdict script in its own header
  // comment, so an unanchored match is satisfied by prose: commenting the invocation out left this
  // whole block green when it was first written. A guard that a `#` defeats is not a guard.
  const CALL = /^python3 "\$HERE\/harvest_ratchet_verdict\.py"/m

  it('writes the verdict into the report BEFORE the shell decides to exit', () => {
    const call = SH.match(CALL)
    expect(call, 'the verdict is never invoked').not.toBeNull()
    const wrote = SH.indexOf('> "$OUT"')
    const blocked = SH.indexOf('BLOCKED — nothing written')
    expect(wrote).toBeGreaterThan(-1)
    expect(call.index).toBeGreaterThan(wrote)
    expect(blocked).toBeGreaterThan(call.index)
  })

  it('lets the verdict exit non-zero without set -e aborting the run', () => {
    expect(SH).toMatch(/^set -euo pipefail$/m)
    // Bare, the exit 1 that MEANS "blocked" would kill the script before it could report why.
    expect(SH).toMatch(/^python3 "\$HERE\/harvest_ratchet_verdict\.py"[\s\S]{0,120}\|\| BLOCK=\$\?/m)
    // An rc the split does not recognise is an ERROR, never a quiet pass.
    expect(SH).toMatch(/\[ "\$BLOCK" -le 1 \][\s\S]{0,80}exit 2/)
  })

  it('publishes on a step that cannot fail the job, and enforces last', () => {
    const reportStep = WF.slice(WF.indexOf('id: report'), WF.indexOf('- name: Summarise'))
    expect(reportStep).toMatch(/set \+e/)
    expect(reportStep).toMatch(/exit 0$/m)      // NOT exit $rc — the red is the Enforce step's job
    expect(reportStep).not.toMatch(/exit \$rc/)
    // Publication ahead of enforcement is what stops a dropped `if: always()` from going dark —
    // and the artifact keeps its own always() as the second layer, not the only one.
    expect(WF.indexOf('- name: Enforce')).toBeGreaterThan(WF.indexOf('upload-artifact'))
    expect(WF).toMatch(/upload-artifact[\s\S]{0,60}if: always\(\)/)
    expect(WF).toMatch(/RC: \$\{\{ steps\.report\.outputs\.rc \}\}/)
    // The summary leads with the verdict; a raw JSON blob is what a reader skips.
    expect(WF).toMatch(/harvest_ratchet_verdict\.py --markdown/)
  })
})

describe('nothing is acked without a recorded reason', () => {
  // This used to assert the list was EMPTY, which only held on day one. The durable invariant is
  // that acking is never silent: an id here suppresses a guard on data Dave reads, so each one must
  // carry the evidence that justified it. An id with no review is how a bad factor gets waved
  // through months later by someone who does not remember why.
  it('every acked cultivar has a review with a decision and a rationale', () => {
    expect(Array.isArray(ACK.reviewed_cultivar_ids)).toBe(true)
    const reviewed = new Set((ACK.reviews || []).map((r) => r.cultivar_id))
    for (const id of ACK.reviewed_cultivar_ids) expect(reviewed.has(id)).toBe(true)
    for (const r of ACK.reviews || []) {
      expect(r.decision, `${r.name} needs a decision`).toBeTruthy()
      expect(r.why, `${r.name} needs a rationale`).toBeTruthy()
      expect(r.reviewed, `${r.name} needs a review date`).toBeTruthy()
    }
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
