// BUG-LAMBDASYNTAX-001 — every deployable Lambda/script file must be PARSEABLE JavaScript.
//
// WHY THIS EXISTS. A backtick-quoted identifier inside a SQL comment, inside a sql`` template
// literal, terminated the template ~100 lines early. Three Lambda entrypoints —
// locations/projects/inventory-items — stopped being parseable JavaScript. The build did not care,
// the unit suites did not care (they import named helpers out of sibling modules, not the
// entrypoint), and the failure mode at runtime is every endpoint 500ing on cold start. It reached
// integration before anyone noticed, and the ledger row closed with "Needs a node --check CI guard"
// — which was never built. This is that guard.
//
// WHY `node --check` AND NOT A LINT RULE OR AN IMPORT. `node --check` is the actual parser the
// runtime will use, which is the only oracle that matters for "will this file load in Lambda".
// Importing each entrypoint instead would execute module-level code — these files construct DB
// clients and read env at import time, so a test that imported them would be testing the harness's
// env, not the syntax. Parsing is the whole assertion and it needs no environment at all.
//
// SCOPE. Deployable source only: lambda/** and scripts/**, excluding node_modules and *.test.js.
// Test files are excluded deliberately — vitest already parses those by running them, so a broken
// test file fails loudly on its own and does not need a second, slower check.
import { describe, it, expect } from 'vitest'
import { spawnSync } from 'node:child_process'
import { readdirSync } from 'node:fs'
import { join, resolve, relative } from 'node:path'

const ROOT = process.cwd()

// A FLOOR, not a decoration. If the walk below ever silently stops matching (a directory rename, a
// bad filter, a future move to lambda/src/), an empty list would make every assertion below pass
// over nothing — the exact vacuous-gate failure OPS-L081COLS-001 records as "worse than an absent
// one because it gets cited as evidence". 147 files at the time of writing; 100 leaves room to
// delete a Lambda without tripping it while still catching a collapse.
const MIN_FILES = 100

function walk(dir, out = []) {
  let entries
  try { entries = readdirSync(dir, { withFileTypes: true }) } catch { return out }
  for (const e of entries) {
    const full = join(dir, e.name)
    if (e.isDirectory()) {
      if (e.name === 'node_modules' || e.name === '__tests__') continue
      walk(full, out)
    } else if (/\.(js|mjs)$/.test(e.name) && !/\.test\.(js|mjs)$/.test(e.name)) {
      out.push(full)
    }
  }
  return out
}

const FILES = [...walk(resolve(ROOT, 'lambda')), ...walk(resolve(ROOT, 'scripts'))].sort()

describe('every deployable Lambda/script file parses (BUG-LAMBDASYNTAX-001)', () => {
  it(`finds at least ${MIN_FILES} files to check — guards against the guard going vacuous`, () => {
    expect(FILES.length).toBeGreaterThanOrEqual(MIN_FILES)
  })

  it('parses cleanly under the real Node parser', () => {
    const broken = []
    for (const f of FILES) {
      const r = spawnSync(process.execPath, ['--check', f], { encoding: 'utf8' })
      if (r.status !== 0) {
        broken.push(`${relative(ROOT, f)}\n${(r.stderr || '').split('\n').slice(0, 4).join('\n')}`)
      }
    }
    expect(broken.join('\n\n---\n')).toBe('')
  }, 120_000)
})
