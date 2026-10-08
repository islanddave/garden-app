// The fixture of the A3 exit checks' counter (./a3-exit.config.mjs, A3_EXIT_FIXTURE=1): tests whose assertion counts
// are known by reading them. ./a3-exit-fixture.test.js runs this file in both environments and holds the
// tests.jsonl it gets to these numbers. Not named *.test.*: no other config collects it.
import { afterAll, describe, expect, test, vi } from 'vitest'

describe('counter fixture', () => {
  test('five through the global expect', () => {
    for (const n of [1, 2, 3, 4, 5]) expect(n).toBe(n)
  })

  test('three through the expect of its own context', ({ expect: own }) => {
    own(1).toBe(1)
    own('a').toBe('a')
    own(true).toBe(true)
  })

  test('two through its own and one through the global', ({ expect: own }) => {
    own(1).toBe(1)
    own(2).toBe(2)
    expect(3).toBe(3)
  })

  test('four after an await', async () => {
    expect(1).toBe(1)
    await Promise.resolve()
    for (const n of [2, 3, 4]) expect(n).toBe(n)
  })

  test.skip('skipped', () => {
    expect(1).toBe(1)
  })

  // Where the environment gave no DOM, this test makes a `document` and leaves it there for the tests after it.
  // Their lines must still say what the environment gave the file: the reading is taken before any test runs.
  test('one, with a document of its own making from here on', () => {
    if (typeof document === 'undefined') vi.stubGlobal('document', {})
    expect(typeof document).toBe('object')
  })

  test('none', () => {})

  afterAll(() => vi.unstubAllGlobals())
})
