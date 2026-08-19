// OPS-NULBYTESRC-001 — no tracked text source may contain a raw NUL (0x00) byte.
//
// Why this is worth a guard rather than a one-time cleanup: a raw 0x00 makes a file BINARY to text
// search tooling, and the failure is silent in the worst possible direction. Measured on
// lambda/plants/merge.js before the fix:
//
//   $ grep -n "superseded_at" lambda/plants/merge.js
//   $ echo $?
//   1                      <- ZERO output, exit 1, indistinguishable from "the string is absent"
//
// The string was present. A 669-line Lambda handler that owns planting merges answered "no match"
// to grep. Anything that greps to decide something — an audit, an impact sweep, a refactor check —
// silently gets a false negative. It cost real time in the session that found it.
//
// The four offenders all used a raw byte as a composite-key delimiter where the two-character
// escape \x00 was meant. Inside a template literal or quoted string those are the SAME runtime
// string (U+0000), so every key and every .split('\x00') is byte-for-byte identical at runtime —
// this is purely a source-encoding fix, not a behavioural one.
//
// NOT affected, checked rather than assumed: git still line-diffs these files (not "Binary files
// differ"), and CodeGraph indexes them normally. The hazard is text search specifically.
import { describe, it, expect } from 'vitest'
import { readFileSync, readdirSync, statSync } from 'fs'
import { join, extname } from 'path'

// process.cwd(), NOT import.meta.url: under vitest the latter resolves with a `/@fs` prefix and
// scandir then ENOENTs. The positive control below is what caught that — it is not decoration.
const ROOT = process.cwd().replace(/\/?$/, '/')
const EXTS = new Set([
  '.js', '.jsx', '.ts', '.tsx', '.mjs', '.cjs',
  '.py', '.sql', '.json', '.yml', '.yaml', '.md', '.sh', '.html', '.css',
])
const SKIP_DIRS = new Set([
  '.git', 'node_modules', 'dist', 'coverage', '.codegraph', '.vite', 'build',
])

function walk(dir, out = []) {
  for (const name of readdirSync(dir)) {
    if (SKIP_DIRS.has(name)) continue
    const full = join(dir, name)
    let st
    try { st = statSync(full) } catch { continue }
    if (st.isDirectory()) walk(full, out)
    else if (EXTS.has(extname(name))) out.push(full)
  }
  return out
}

describe('OPS-NULBYTESRC-001 — source files must be greppable', () => {
  it('no tracked text source contains a raw NUL byte', () => {
    const offenders = []
    for (const file of walk(ROOT)) {
      let buf
      try { buf = readFileSync(file) } catch { continue }
      const n = buf.filter((b) => b === 0).length
      if (n > 0) offenders.push(`${file.slice(ROOT.length)} (${n} NUL byte${n === 1 ? '' : 's'})`)
    }
    // Non-vacuity is provable by construction: this assertion FAILED on the pre-fix tree, listing
    // exactly the four known files. Put a raw 0x00 back into any one of them and it reds again.
    expect(offenders, `use the two-character escape \\x00 instead of a raw byte:\n${offenders.join('\n')}`)
      .toEqual([])
  })

  it('the walker actually reaches source files — a guard over an empty set proves nothing', () => {
    // Positive control. Without this, a broken SKIP_DIRS or a wrong ROOT would scan zero files and
    // the assertion above would pass while checking nothing at all.
    const files = walk(ROOT)
    expect(files.length).toBeGreaterThan(500)
    expect(files.some((f) => f.endsWith('lambda/plants/merge.js'))).toBe(true)
    expect(files.some((f) => f.endsWith('src/lib/cal1Seed.js'))).toBe(true)
  })
})
