// Reporter of ./a3-exit.config.mjs: at the end of the run, <out>/tests.jsonl, which ./a3-exit.py e1 compares between
// the two environments.
//
// Line 1 is a header: {"a3_exit": 2, "env", "files", "tests", "left_out", "notes"}. Then one line per test, in the
// order vitest reports the files (sorted here by file) and the tests inside each:
//   {"file": repo-relative path, "name": full test name, "state": passed|failed|skipped|pending,
//    "assertionCalls": number, or null when the test never ran,
//    "dom": true|false, whether the test's file had a `document`, or null when the test never ran}
// Both come from ./a3-exit-count.mjs through the task's meta; the count's limits are written there and repeated in
// the header's notes. A file that collected no test (it failed to import) gets one line with "name": null, so it
// cannot vanish from one side unseen.
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

export const FORMAT = 2

export const NOTES = [
  'assertionCalls counts assertions made through vitest expect (the global one plus the test context one); a test '
    + 'that asserts only with node:assert or by throwing reads 0 in both environments',
  'a test.concurrent test using the global expect shares its count with its siblings',
  'a skipped or todo test carries null',
]

export function testLines(testModules) {
  const lines = []
  const sorted = [...testModules].sort((a, b) => (a.relativeModuleId < b.relativeModuleId ? -1 : 1))
  for (const mod of sorted) {
    const file = mod.relativeModuleId
    let seen = 0
    for (const test of mod.children.allTests()) {
      seen += 1
      const { a3ExitAssertions: calls, a3ExitDom: dom } = test.meta()
      lines.push({ file, name: test.fullName, state: test.result().state,
        assertionCalls: typeof calls === 'number' ? calls : null, dom: typeof dom === 'boolean' ? dom : null })
    }
    if (seen === 0) lines.push({ file, name: null, state: mod.state(), assertionCalls: null, dom: null })
  }
  return lines
}

export default class A3ExitRecorder {
  constructor({ out, mode, leftOut = [] }) {
    this.out = out
    this.mode = mode
    this.leftOut = leftOut
  }

  onTestRunEnd(testModules) {
    const lines = testLines(testModules)
    const header = { a3_exit: FORMAT, env: this.mode, files: testModules.length,
      tests: lines.filter((line) => line.name !== null).length, left_out: this.leftOut, notes: NOTES }
    mkdirSync(this.out, { recursive: true })
    writeFileSync(join(this.out, 'tests.jsonl'), [header, ...lines].map((line) => `${JSON.stringify(line)}\n`).join(''))
  }
}
