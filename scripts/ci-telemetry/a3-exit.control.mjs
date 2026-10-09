// The control of the A3 exit checks' E2 (./a3-exit.config.mjs, A3_EXIT_CONTROL=1): one test that imports nothing of
// the repo. Run under jsdom with coverage, the only repo modules it loads are the ones src/__tests__/setup.ts
// loads, so its coverage file is the list of them. Not named *.test.*: no other config collects it.
import { expect, test } from 'vitest'

test('loads nothing', () => {
  expect(1).toBe(1)
})
