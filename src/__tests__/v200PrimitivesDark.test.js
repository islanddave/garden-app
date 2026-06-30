// V4-THEME-001 — "ships dark" guard. The V200 foundation primitives are added to the frozen
// barrel ahead of their adopting slices; this asserts they have ZERO runtime importers (outside
// their own source + tests) until a slice wires them. When a slice adopts one, REMOVE it from
// DARK here in that same change (the removal is the intentional, reviewed "lighting it up").
import { describe, it, expect } from 'vitest'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'

const DARK = ['SegmentedControl', 'Sheet']
const ROOT = 'src'

function walk(dir, acc = []) {
  for (const e of readdirSync(dir)) {
    const p = join(dir, e)
    const st = statSync(p)
    if (st.isDirectory()) walk(p, acc)
    else if (/\.(jsx?|mjs)$/.test(e)) acc.push(p)
  }
  return acc
}

describe('V200 foundation primitives ship dark (V4-THEME-001)', () => {
  const files = walk(ROOT)
  for (const name of DARK) {
    it(`${name} has no runtime importer yet`, () => {
      const importers = files.filter(f => {
        if (f.includes('__tests__')) return false
        if (f.endsWith(`forms/${name}.jsx`)) return false
        const src = readFileSync(f, 'utf8')
        // direct import OR named import from the forms barrel
        const direct = new RegExp(`from ['"][^'"]*forms/${name}(\\.jsx)?['"]`).test(src)
        const barrel = new RegExp(`import\\s*\\{[^}]*\\b${name}\\b[^}]*\\}\\s*from ['"][^'"]*forms(/index\\.js)?['"]`).test(src)
        return direct || barrel
      })
      expect(importers).toEqual([])
    })
  }
})
