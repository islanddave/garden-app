// Reporter of ./a3-exit.config.mjs: at the end of the run, <out>/tests.jsonl, which ./a3-exit.py e1 compares between
// the two environments.
//
// Line 1 is a header: {"a3_exit": 1, "env", "files", "tests", "left_out", "notes"}. Then one line per test, in the
// order vitest reports the files (sorted here by file) and the tests inside each:
//   {"file": repo-relative path, "name": full test name, "state": passed|failed|skipped|pending,
//    "assertionCalls": number, or null when the test never ran}
// The count comes from ./a3-exit-count.mjs through the task's meta; its limits are written there and repeated in the
// header's notes. A file that collected no test (it failed to import) gets one line with "name": null, so it cannot
// vanish from one side unseen.
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

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
      const calls = test.meta().a3ExitAssertions
      lines.push({ file, name: test.fullName, state: test.result().state,
        assertionCalls: typeof calls === 'number' ? calls : null })
    }
    if (seen === 0) lines.push({ file, name: null, state: mod.state(), assertionCalls: null })
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
    const header = { a3_exit: 1, env: this.mode, files: testModules.length,
      tests: lines.filter((line) => line.name !== null).length, left_out: this.leftOut, notes: NOTES }
    mkdirSync(this.out, { recursive: true })
    writeFileSync(join(this.out, 'tests.jsonl'), [header, ...lines].map((line) => `${JSON.stringify(line)}\n`).join(''))
  }
}
