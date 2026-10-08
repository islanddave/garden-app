// late.mjs left in flight, as a lazy import() that a test does not wait for leaves src/lib/harvestWindows.js in two
// test files of the unit run: compiled, entered, stopped at its first import, and still there when the worker's
// coverage is taken. vitest records a module's start offset when it has finished evaluating, so this script has
// none, though it is vite's text behind the wrapper like any other.
import { test, expect } from 'vitest'

globalThis.__COVERAGE_TWO_FORMS_HOLD__ = true
const inFlight = import('./late.mjs').then(() => 'loaded')

test('late.mjs, still being evaluated when the test ends', async () => {
  const soon = new Promise((resolve) => { setTimeout(() => resolve('in flight'), 50) })
  expect(await Promise.race([inFlight, soon])).toBe('in flight')
})
