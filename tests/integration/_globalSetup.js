// tests/integration/_globalSetup.js — BUG-INTFIXTURELEAK-001.
//
// Wired as vitest `globalSetup` in vitest.integration.config.ts. This is the LOAD-BEARING half of
// the leak fix: per-file afterAll() hooks are best-effort and are skipped entirely when a beforeAll
// throws, when a file fails to import, or when the run is cancelled — all of which leave fixtures
// behind. globalSetup's teardown() runs once after every test file, pass or fail, in the parent
// process, so it is the only hook that can actually guarantee the namespace is empty at exit.
//
// setup():    refuses to run against a protected long-lived endpoint, then records the pre-existing
//             fixture residue so teardown can prove it returned to that baseline.
// teardown(): sweeps the `int-test-` namespace and reports. Namespace-guarded — see _cleanup.js.

import { neon } from '@neondatabase/serverless'
import { assertEphemeralDatabase, sweepFixtures, countFixtureResidue } from './_cleanup.js'

let baseline = null

export async function setup() {
  const { host, protected: isProtected } = assertEphemeralDatabase()
  console.log(`[int-cleanup] target endpoint: ${host}${isProtected ? ' (PROTECTED — override in effect)' : ''}`)

  const sql = neon(process.env.INT_DATABASE_URL)
  // Pre-existing residue from an earlier aborted run. Sweeping it up front means the suite starts
  // from a known-clean namespace and teardown's "returned to baseline" claim means baseline == 0.
  const before = await countFixtureResidue(sql)
  if (before.total > 0) {
    console.warn(`[int-cleanup] pre-run residue: ${before.total} rows ${JSON.stringify(before.byTable)} — sweeping`)
    await sweepFixtures(sql)
  }
  baseline = await countFixtureResidue(sql)
  console.log(`[int-cleanup] baseline fixture rows: ${baseline.total}`)
}

export async function teardown() {
  // vitest still calls teardown when setup() threw. If the endpoint guard rejected the target we
  // never wrote a fixture, so there is nothing to sweep — and we should not reconnect to a database
  // we just refused to use.
  if (baseline === null) {
    console.log('[int-cleanup] teardown: setup did not complete — nothing seeded, nothing to sweep')
    return
  }
  const sql = neon(process.env.INT_DATABASE_URL)

  const before = await countFixtureResidue(sql)
  const result = await sweepFixtures(sql)
  const after = await countFixtureResidue(sql)

  console.log(
    `[int-cleanup] teardown: residue before=${before.total} swept=${result.total} after=${after.total} ` +
    `(baseline=${baseline?.total ?? 0})`,
  )

  if (result.failures.length > 0) {
    // Loud, but not fatal — a failed sweep must not mask the actual test result. The residue
    // assertion below is what turns a genuine leak into a non-zero exit.
    console.error(`[int-cleanup] ${result.failures.length} sweep step(s) failed:`)
    for (const f of result.failures) console.error(`  - ${f.table}: ${f.error}`)
  }

  if (after.total > (baseline?.total ?? 0)) {
    throw new Error(
      `[int-cleanup] FIXTURE LEAK: ${after.total} fixture rows survived teardown ` +
      `(baseline ${baseline?.total ?? 0}) — ${JSON.stringify(after.byTable)}. ` +
      'This is BUG-INTFIXTURELEAK-001 recurring; do not ignore.',
    )
  }
}
