// V4-PERFCLERK-001 Option A — static guard on the src/main.jsx boot warm-ping wiring.
//
// WHY A FILE-READING TEST: main.jsx is the entry module. Importing it calls
// createRoot(document.getElementById('root')) against a jsdom document that has no #root, mounts the
// whole app, and boots a real ClerkProvider — so it is not importable under vitest. Same house
// pattern as bootPaint.static.test.js / viewportMeta.static.test.js.
//
// WHAT IT CATCHES: silent loss of the call site. It is pure-performance — the app WORKS without
// it, which is exactly why nothing else in CI would ever notice it had gone. warmOrigins.test.js
// proves the warm-ping BEHAVES; only this file proves anything ever CALLS it. A perfectly-tested
// module that no entry point imports is dead code with a green suite.
//
// WHAT IT DOES NOT CATCH: whether the warm-ping actually retires the Lambda cold start. That is a
// device measurement on Chrome for Android and is not assertable in jsdom.
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const main = readFileSync(resolve(process.cwd(), 'src/main.jsx'), 'utf8')

// Source with comments removed. Every assertion below runs against this: the rationale comments in
// main.jsx quote the very identifiers being matched (`prefetchUI`, `warmApiOrigins`), so a matcher
// run over raw source would stay green on a change that deleted the code and kept the comment.
const code = main.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^[ \t]*\/\/.*$/gm, '')

describe('main.jsx boot warm-ping wiring (V4-PERFCLERK-001 Option A)', () => {
  it('imports and CALLS warmApiOrigins', () => {
    expect(code).toMatch(/import\s*\{\s*warmApiOrigins\s*\}\s*from\s*'\.\/lib\/warmOrigins\.js'/)
    expect(code).toMatch(/^\s*warmApiOrigins\(\)/m)
  })

  it('fires it BEFORE createRoot — the Clerk dead window is the whole point', () => {
    // React's initial render is main-thread work of unbounded length on a mid-range Android. Firing
    // the pings after it would spend part of the window the pings exist to occupy.
    const call = code.search(/^\s*warmApiOrigins\(\)/m)
    const root = code.indexOf('createRoot(')
    expect(call).toBeGreaterThan(-1)
    expect(root).toBeGreaterThan(-1)
    expect(call).toBeLessThan(root)
  })

  it('is not awaited and its result is not consumed', () => {
    // An `await` here would put the ~1.4s cold start back on the critical path pointing the wrong
    // way — strictly worse than not warming at all.
    expect(code).not.toMatch(/await\s+warmApiOrigins/)
    expect(code).not.toMatch(/=\s*warmApiOrigins\(/)
    expect(code).not.toMatch(/warmApiOrigins\(\)\s*\./)
  })

  it('SELF-TEST: the comment stripper does not hide a real call, and does hide a commented one', () => {
    const stripper = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^[ \t]*\/\/.*$/gm, '')
    expect(stripper('// warmApiOrigins()\n')).not.toMatch(/warmApiOrigins/)
    expect(stripper('warmApiOrigins()\n')).toMatch(/warmApiOrigins/)
  })
})
