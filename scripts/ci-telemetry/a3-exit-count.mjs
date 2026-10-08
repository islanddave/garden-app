// Setup file of ./a3-exit.config.mjs, loaded in both environments: after each test, how many assertions it made,
// left on the task's meta for ./a3-exit-recorder.mjs to write out.
//
// The count is `assertionCalls` of vitest's expect state, which the runner zeroes before each test. A test can reach
// two expects: the global one (`expect` as a global or imported from 'vitest') and the one on its own context
// (`test('…', ({ expect }) => …)`), each with its own state, so both are read and added.
// What it cannot see: an assertion made any other way (node:assert, a thrown Error) reads 0 in both environments,
// and a `test.concurrent` test using the global expect shares that state with its siblings.
// A skipped or todo test never gets here and its line carries null.
import { afterEach, expect } from 'vitest'

afterEach((context) => {
  let calls = expect.getState().assertionCalls || 0
  try {
    if (context.expect && context.expect !== expect) calls += context.expect.getState().assertionCalls || 0
  } catch { /* a context with no expect of its own: the global count stands */ }
  context.task.meta.a3ExitAssertions = calls
})
