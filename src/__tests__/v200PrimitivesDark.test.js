// V4-THEME-001 — "ships dark" guard. The V200 foundation primitives are added to the codebase
// ahead of their adopting slices; this asserts they have ZERO runtime importers (outside their
// own source + tests) until a slice wires them. When a slice adopts one, REMOVE it from DARK
// here in that same change (the removal is the intentional, reviewed "lighting it up").
//
// Entries carry their own source path + whether they are forms-barrel-exported. A forms
// primitive is matched on a consumer `forms/<name>` import (the barrel's OWN `./<name>`
// re-export is NOT a consumer). A components primitive (e.g. Lightbox — not a form, not
// barreled) is matched on any import path ending in `/<name>`.
import { describe, it, expect } from 'vitest'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'

const DARK = [
  // Slice 3 (V200) lit up BOTH SegmentedControl (wired in Garden as the Plants|Photos sub-tab)
  // AND Lightbox (wired in PhotosWall as the photo viewer) — removed here in that same change.
  // Slice 5b (V200) lit up Sheet — adopted as the tabbed Details fly-up on PlantingDetail; it
  // ALSO re-uses SegmentedControl (already lit) and Lightbox (already lit). DARK is now empty:
  // every V200 foundation primitive has a runtime importer. The guard remains so a regression
  // that re-darkens one would re-add it here intentionally.
]
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
  // As of Slice 5b every V200 foundation primitive is lit (DARK is empty). This guard remains so
  // that a future regression which re-darkens one is re-recorded above intentionally.
  it('all V200 foundation primitives are now lit (DARK list drained)', () => {
    expect(DARK).toEqual([])
  })
  for (const { name, self, barrel } of DARK) {
    it(`${name} has no runtime importer yet`, () => {
      const importers = files.filter(f => {
        if (f.includes('__tests__')) return false
        if (f === self) return false
        const src = readFileSync(f, 'utf8')
        const direct = barrel
          ? new RegExp(`from ['"][^'"]*forms/${name}(\\.jsx)?['"]`).test(src)
          : new RegExp(`from ['"][^'"]*/${name}(\\.jsx)?['"]`).test(src)
        const barrelImport = barrel &&
          new RegExp(`import\\s*\\{[^}]*\\b${name}\\b[^}]*\\}\\s*from ['"][^'"]*forms(/index\\.js)?['"]`).test(src)
        return direct || barrelImport
      })
      expect(importers).toEqual([])
    })
  }
})
