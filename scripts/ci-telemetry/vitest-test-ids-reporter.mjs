// Test-ID evidence for the CI shadow comparison (PLAN-V003 §4 A2.2: "vitest test-ID set (file + full name + state)
// equal for both passes").
//
// ci.yml runs the unit suite twice in one serial job (UTC with coverage, then America/New_York); ci-next.yml runs the
// same two passes in two parallel legs. This reporter lets the two workflows be compared on one SHA: at the end of a
// run it prints ONE line, a GitHub notice annotation, carrying the sha256 of the sorted list
//
//     file :: full test name :: state
//
// and the counts behind it. The annotation lands on the job's check-run, where scripts/ci-telemetry/shadow-agree.py
// reads it back (GET /check-runs/<job id>/annotations). Its title names the zone the pass ran under ("test-ids UTC",
// "test-ids America/New_York"), so the two passes of the serial job cannot overwrite each other: nothing is stored
// on disk, and each pass has its own title.
//
// It is switched on in vitest.config.ts under GITHUB_ACTIONS only, so no workflow step changes and a local run
// prints nothing.
//
// IT MUST NEVER FAIL A RUN. vitest calls reporters with Promise.all and does not catch what they throw, so every
// hook here catches everything and says so in a ::warning instead. A pass with no notice reads as TEST-IDS-ABSENT
// in shadow-agree, never as equal.
//
// ONE line, deliberately. The list itself (about 23,000 lines) is not printed: this runs inside the gating unit
// step, and that step's log is what a session reads when the suite is red.
import { createHash } from 'node:crypto'

export const TITLE_PREFIX = 'test-ids '
export const FORMAT_VERSION = 1
const STATES = ['passed', 'failed', 'skipped', 'pending']

const oneLine = (text) => String(text).replace(/\\/g, '\\\\').replace(/\r/g, '\\r').replace(/\n/g, '\\n')

/** The zone this pass ran under, as it goes in the annotation title. The UTC pass sets no TZ on the runner. */
export function zoneLabel(env = process.env) {
  return String(env.TZ || 'UTC').replace(/[^A-Za-z0-9_/+-]/g, '_')
}

/**
 * The sorted list, one line per test. A module that collected no test (it failed to import, or every test in it was
 * filtered out) gets one line of its own, so a file that vanishes from one side still moves the hash.
 * Sorted by UTF-16 code unit, which no locale changes.
 */
export function testIdLines(testModules) {
  const lines = []
  for (const mod of testModules) {
    const file = oneLine(mod.relativeModuleId)
    let seen = 0
    for (const test of mod.children.allTests()) {
      seen += 1
      lines.push(`${file} :: ${oneLine(test.fullName)} :: ${test.result().state}`)
    }
    if (seen === 0) lines.push(`${file} :: (no tests collected) :: ${mod.state()}`)
  }
  return lines.sort()
}

/** sha256 of the list as UTF-8, one line per test, each ended by a newline. */
export function digest(lines) {
  return createHash('sha256').update(lines.map((line) => `${line}\n`).join(''), 'utf8').digest('hex')
}

/** The annotation's message: `key=value` tokens, so shadow-agree parses it without a format of its own. */
export function summary(testModules, reason) {
  const lines = testIdLines(testModules)
  const counts = Object.fromEntries(STATES.map((state) => [state, 0]))
  let tests = 0
  for (const mod of testModules) {
    for (const test of mod.children.allTests()) {
      tests += 1
      const state = test.result().state
      if (state in counts) counts[state] += 1
    }
  }
  return [`sha256=${digest(lines)}`, `tests=${tests}`, ...STATES.map((state) => `${state}=${counts[state]}`),
    `files=${testModules.length}`, `reason=${reason}`, `v=${FORMAT_VERSION}`].join(' ')
}

export default class TestIdsReporter {
  constructor({ write = (text) => process.stdout.write(text), env = process.env } = {}) {
    this.write = write
    this.env = env
  }

  onTestRunEnd(testModules, _unhandledErrors, reason) {
    let zone = 'unknown'
    try {
      zone = zoneLabel(this.env)
      this.write(`\n::notice title=${TITLE_PREFIX}${zone}::${summary(testModules, reason)}\n`)
    } catch (err) {
      try {
        const why = String((err && err.message) || err).replace(/[\r\n%]+/g, ' ').slice(0, 200)
        this.write(`\n::warning title=${TITLE_PREFIX}${zone}::no test-ID evidence for this pass: ${why}\n`)
      } catch { /* evidence only: nothing here may fail the run */ }
    }
  }
}
