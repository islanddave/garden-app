// The V1 Today mutation catalogue (tests/harness/todayMutants.mjs), checked without a browser — the port of
// v2contract.test.mjs's "pattern occurs exactly once" (prepromote-v5-qa.md MINOR, 2026-10-15). The V1 matrix runs
// outside CI (npm run mutate:today-shape), so a pattern the source moved away from was found only by hand: v5.0.0 gave
// Today.jsx's LeafWetnessLine mount a planDate and dropLeafWetness quietly stopped applying. vite.harness.mutant.mjs
// throws on a missing pattern and replaces EVERY occurrence, so each must occur exactly once in its file.
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { MUTANTS } from '../todayMutants.mjs'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..')

describe('V1 Today mutation catalogue', () => {
  it('names 26 mutants, each [file, pattern, replacement, defect], none a no-op', () => {
    const all = Object.entries(MUTANTS)
    expect(all).toHaveLength(26) // ci.yml's gates-b comment: "red on all 26 mutants"
    for (const [n, m] of all) {
      expect(m, n).toHaveLength(4)
      expect(m.every((x) => typeof x === 'string' && x.length > 0), n).toBe(true)
      expect(m[2], n).not.toBe(m[1])
    }
  })
  it('every pattern occurs exactly once in its file', () => {
    for (const [n, [file, find]] of Object.entries(MUTANTS)) {
      expect(readFileSync(join(ROOT, file), 'utf8').split(find).length - 1, `${n} → ${file}`).toBe(1)
    }
  })
})
