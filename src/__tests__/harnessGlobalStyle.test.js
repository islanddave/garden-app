// BUG-HARNESSGLOBALCSS-001 — pin the harness's copy of the app's global stylesheet to the original.
//
// WHY THIS GUARD EXISTS. The app builds its only global stylesheet in JavaScript
// (src/main.jsx:10-24) rather than shipping a .css file, and appends it to document.head at boot.
// The layout harness mounts components WITHOUT src/main.jsx — that module also boots Clerk, the
// service worker and warmApiOrigins() — so it has to carry its own copy in
// tests/harness/appGlobalStyle.js.
//
// Two copies of a cascade is a drift hazard, and this one is the expensive kind: the harness exists
// to answer layout questions, and box-sizing plus the font stack silently decide every wrap point,
// height and fold clearance it reports. When the copy was simply ABSENT (the state until
// 2026-09-01), `/seeds/saved`'s sheet inputs measured 416px inside a 390px sheet under the UA's
// content-box default — a clean-looking 26px overflow that does not exist in prod. A guard that only
// fires on absence would not have caught a partial copy, so this compares the declarations.
//
// WHAT IT DOES NOT CATCH: whether the harness actually LOADS appGlobalStyle.js. That is the
// transformIndexHtml hook in vite.harness.config.mjs, which no vitest run executes — asserted here
// only as "the hook is still wired up", by reading the config as text.
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const read = (p) => readFileSync(resolve(process.cwd(), p), 'utf8')

// Non-greedy, so it stops at the template literal's own closing backtick rather than running to the
// end of the file — an unbounded match here would silently swallow unrelated source and compare it.
function styleBlock(source) {
  const m = source.match(/globalStyle\.textContent = `([\s\S]*?)`\s*$/m)
  return m ? m[1] : null
}

// CSS comments are documentation, not cascade. src/main.jsx carries a five-line one explaining the
// --bottom-nav-height default that the harness copy deliberately does not repeat; comparing raw text
// would fail on that difference and teach the next person to delete the explanation.
function declarations(block) {
  return block
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean)
    .sort()
}

const appBlock = styleBlock(read('src/main.jsx'))
const harnessBlock = styleBlock(read('tests/harness/appGlobalStyle.js'))

describe('harness global stylesheet mirrors the app (BUG-HARNESSGLOBALCSS-001)', () => {
  it('both style blocks are found and non-trivial', () => {
    // Guards the guard: a regex that stopped matching would make every comparison below vacuous by
    // comparing null to null.
    expect(appBlock).not.toBeNull()
    expect(harnessBlock).not.toBeNull()
    expect(declarations(appBlock).length).toBeGreaterThanOrEqual(5)
  })

  it('declares the same rules, in the same set', () => {
    expect(declarations(harnessBlock)).toEqual(declarations(appBlock))
  })

  it('still carries the two declarations that decide every harness measurement', () => {
    // Named explicitly rather than left to the set comparison: if both copies ever drop these
    // together the set test stays green, and the harness goes back to measuring UA defaults.
    const joined = declarations(harnessBlock).join('\n')
    expect(joined).toContain('box-sizing: border-box')
    expect(joined).toContain('-apple-system')
    expect(joined).toContain('font: inherit')
  })

  it('the harness config still injects it into every entry', () => {
    // The set comparison above is worthless if nothing loads the file. This is the cheapest
    // available check that the wiring survives — it reads the config, it does not run it.
    const cfg = read('tests/harness/vite.harness.config.mjs')
    expect(cfg).toContain('appGlobalStyle')
    expect(cfg).toContain('transformIndexHtml')
    expect(cfg).toMatch(/plugins:\s*\[[^\]]*appGlobalStyle\(\)/)
  })

  it('SELF-TEST: the comparison actually fails on a drifted copy', () => {
    // Mandatory per the static-test house pattern (viewportMeta.static.test.js). Without it, a
    // normalizer that collapsed everything to [] would report two empty sets as equal and this
    // whole file would pass while guarding nothing.
    const drifted = declarations(appBlock).filter((l) => !l.includes('box-sizing'))
    expect(drifted).not.toEqual(declarations(appBlock))
    expect(declarations('  a { color: inherit; }')).toEqual(['a { color: inherit; }'])
    expect(declarations('  /* only a comment */  ')).toEqual([])
  })
})
